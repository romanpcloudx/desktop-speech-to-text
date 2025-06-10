/* Renderer process: handles microphone capture, waveform visualisation, Deepgram request and clipboard copy */

(async () => {
  // Basic i18n strings (English / Spanish)
  const locale = navigator.language.startsWith('es') ? 'es' : 'en';
  const t = {
    en: {
      stop: 'Stop',
      copied: 'Transcript copied!',
      permission: 'Microphone permission denied',
    },
    es: {
      stop: 'Detener',
      copied: '¡Transcripción copiada!',
      permission: 'Permiso de micrófono denegado',
    },
  }[locale];

  const cancelBtn = document.getElementById('cancelBtn');
  const confirmBtn = document.getElementById('confirmBtn');
  const spinner = document.getElementById('spinner');
  const canvas = document.getElementById('wave');
  const container = document.getElementById('container');

  const dgKey = await window.electronAPI.getDeepgramKey();

  if (!dgKey) {
    alert('Deepgram API key not found. Please set DEEPGRAM_API_KEY in your .env file.');
    window.electronAPI.closeOverlay();
    return;
  }

  window.electronAPI.debug('Deepgram API key loaded successfully');
  window.electronAPI.debug(`Browser language: ${navigator.language}, using locale: ${locale}`);

  let chunks = [];
  let mediaRecorder;
  let audioContext, analyser, dataArray, animationId;
  let recordingStartTime;
  const MIN_RECORDING_DURATION = 1000; // 1 second minimum
  let shouldProcessAudio = true; // Flag to determine if we should process the audio

  async function startRecording() {
    try {
      window.electronAPI.debug('Requesting microphone access...');
      
      // Check if getUserMedia is available
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('getUserMedia not supported in this browser');
      }
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      window.electronAPI.debug('Microphone access granted, setting up audio context...');

      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      dataArray = new Uint8Array(analyser.fftSize);

      draw();

      let mimeType = 'audio/webm;codecs=opus';
      if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
        mimeType = 'audio/ogg;codecs=opus';
      } else if (MediaRecorder.isTypeSupported('audio/webm')) {
        mimeType = 'audio/webm';
      } else if (MediaRecorder.isTypeSupported('audio/wav')) {
        mimeType = 'audio/wav';
      }

      window.electronAPI.debug(`Using MIME type: ${mimeType}`);

      const options = { 
        mimeType,
        audioBitsPerSecond: 64000  // Lower bitrate for better compatibility
      };
      mediaRecorder = new MediaRecorder(stream, options);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunks.push(e.data);
          window.electronAPI.debug(`Audio chunk received: ${e.data.size} bytes`);
        }
      };

      mediaRecorder.onstop = () => {
        window.electronAPI.debug('Recording stopped, processing audio...');
        cancelAnimationFrame(animationId);
        audioContext.close();
        const blob = new Blob(chunks, { type: mimeType.split(';')[0] });
        window.electronAPI.debug(`Final audio blob created: ${blob.size} bytes`);
        chunks = [];
        
        if (shouldProcessAudio) {
          sendToDeepgram(blob);
        } else {
          window.electronAPI.debug('Audio processing skipped (cancelled)');
          window.electronAPI.closeOverlay();
        }
      };

      mediaRecorder.start(1000); // Generate data every 1 second
      window.electronAPI.debug('Recording started successfully with 1s timeslices');
      recordingStartTime = Date.now();
      shouldProcessAudio = true; // Reset flag for new recording
    } catch (err) {
      window.electronAPI.debug(`Recording failed: ${err.message}`);
      console.error(err);
      alert(t.permission);
      window.electronAPI.closeOverlay();
    }
  }

  function draw() {
    const ctx = canvas.getContext('2d');
    // Ensure canvas internal resolution matches CSS size for crisp lines
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    const { width, height } = canvas;

    function render() {
      animationId = requestAnimationFrame(render);
      analyser.getByteTimeDomainData(dataArray);

      ctx.clearRect(0, 0, width, height);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#4f8cff';
      ctx.beginPath();

      const sliceWidth = width / dataArray.length;
      let x = 0;

      for (let i = 0; i < dataArray.length; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * height) / 2;

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }

        x += sliceWidth;
      }

      ctx.lineTo(width, height / 2);
      ctx.stroke();
    }

    render();
  }

  async function sendToDeepgram(blob) {
    spinner.style.display = 'block';
    container.style.opacity = '0.7';
    cancelBtn.classList.add('hidden');
    confirmBtn.classList.add('hidden');

    try {
      window.electronAPI.debug('Starting Deepgram transcription...');
      
      const arrayBuffer = await blob.arrayBuffer();
      
      window.electronAPI.debug(`Audio blob size: ${blob.size} bytes, type: ${blob.type}`);
      
      const params = new URLSearchParams({
        model: 'nova-2',
        smart_format: 'true',
        language: 'es',
        punctuate: 'true',
        numerals: 'true',
      });

      window.electronAPI.debug(`Making request to Deepgram with params: ${params.toString()}`);

      const response = await fetch(
        `https://api.deepgram.com/v1/listen?${params.toString()}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Token ${dgKey}`,
            'Content-Type': 'application/octet-stream',
          },
          body: arrayBuffer,
        }
      );

      window.electronAPI.debug(`Deepgram HTTP status: ${response.status}`);
      window.electronAPI.debug(`Deepgram response headers: ${JSON.stringify([...response.headers.entries()])}`);

      let data;
      try {
        data = await response.json();
        window.electronAPI.debug(`Deepgram parsed JSON: ${JSON.stringify(data, null, 2)}`);
      } catch (e) {
        window.electronAPI.debug(`Failed JSON.parse Deepgram response: ${e.message}`);
        try {
          const txt = await response.text();
          window.electronAPI.debug(`Deepgram raw text response: ${txt.slice(0, 500)}`);
        } catch (_) {
          window.electronAPI.debug('Could not get raw text response either');
        }
        data = null;
      }

      if (!response.ok) {
        const msg = data?.detail || data?.error || response.statusText;
        window.electronAPI.debug(`Deepgram API error: ${msg}`);
        throw new Error(`Deepgram error ${response.status}: ${msg}`);
      }

      const transcript =
        data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';

      window.electronAPI.debug(`Extracted transcript: "${transcript}"`);
      window.electronAPI.debug(`Transcript length: ${transcript.length}`);

      if (transcript) {
        window.electronAPI.debug(`Transcript successfully obtained: "${transcript}"`);
        
        try {
          await navigator.clipboard.writeText(transcript);
          window.electronAPI.debug('Transcript copied to clipboard successfully via Clipboard API');
        } catch (err) {
          window.electronAPI.debug(`Clipboard API failed: ${err.message}, trying fallback...`);
          try {
            // Fallback to main process clipboard
            window.electronAPI.copyToClipboard(transcript);
            window.electronAPI.debug('Transcript copied to clipboard successfully via fallback');
          } catch (fallbackErr) {
            window.electronAPI.debug(`Fallback clipboard also failed: ${fallbackErr.message}`);
            // Still show notification even if clipboard fails
            alert(`Transcripción: ${transcript}`);
          }
        }

        notifyCopied();
        window.electronAPI.debug('Transcription process completed successfully');
      } else {
        window.electronAPI.debug('No transcript field returned from Deepgram. Full response object logged above.');
        window.electronAPI.debug(`Full data structure: ${JSON.stringify(data, null, 2)}`);
        alert('No transcript returned');
      }
    } catch (err) {
      window.electronAPI.debug(`Error during transcription: ${err.message || err}`);
      console.error(err);
      alert(`Error while transcribing audio: ${err.message || err}`);
    } finally {
      window.electronAPI.debug('Closing overlay...');
      // Add a small delay to ensure logs are processed
      setTimeout(() => {
        window.electronAPI.closeOverlay();
      }, 100);
    }
  }

  function notifyCopied() {
    window.electronAPI.debug('Attempting to show notification...');
    
    if ('Notification' in window) {
      if (Notification.permission === 'granted') {
        new Notification(t.copied);
        window.electronAPI.debug('Notification shown successfully');
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then((perm) => {
          if (perm === 'granted') {
            new Notification(t.copied);
            window.electronAPI.debug('Notification permission granted and shown');
          } else {
            window.electronAPI.debug('Notification permission denied');
          }
        });
      } else {
        window.electronAPI.debug('Notifications are denied');
      }
    } else {
      window.electronAPI.debug('Notifications not supported');
    }
  }

  // Handle cancel and confirm buttons
  cancelBtn.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      // Cancel recording without processing
      shouldProcessAudio = false;
      mediaRecorder.stop();
      window.electronAPI.debug('Recording cancelled by user');
    }
  });

  confirmBtn.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      const recordingDuration = Date.now() - recordingStartTime;
      if (recordingDuration < MIN_RECORDING_DURATION) {
        window.electronAPI.debug(`Recording too short: ${recordingDuration}ms, minimum is ${MIN_RECORDING_DURATION}ms`);
        alert(`Por favor graba por al menos 1 segundo. Duración actual: ${Math.round(recordingDuration/100)/10}s`);
        return;
      }
      shouldProcessAudio = true;
      mediaRecorder.stop();
    }
  });

  window.electronAPI.onShortcutToggle(() => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      const recordingDuration = Date.now() - recordingStartTime;
      if (recordingDuration < MIN_RECORDING_DURATION) {
        window.electronAPI.debug(`Recording too short: ${recordingDuration}ms, minimum is ${MIN_RECORDING_DURATION}ms`);
        alert(`Por favor graba por al menos 1 segundo. Duración actual: ${Math.round(recordingDuration/100)/10}s`);
        return;
      }
      mediaRecorder.stop();
    }
  });

  // Kick things off
  startRecording();
})();

