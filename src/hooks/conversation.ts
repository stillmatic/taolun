import {
  IMediaRecorder,
  MediaRecorder,
  register,
} from "extendable-media-recorder";
import { connect } from "extendable-media-recorder-wav-encoder";
import React from "react";
import {
  ConversationConfig,
  ConversationStatus,
  CurrentSpeaker,
  SelfHostedConversationConfig,
  Transcript,
} from "../types/conversation";
import { blobToBase64, stringify } from "../utils";
import { AudioEncoding } from "../types/taolun/audioEncoding";
import {
  AudioConfigStartMessage,
  AudioMessage,
  StartMessage,
  StopMessage,
} from "../types/taolun/websocket";
import { DeepgramTranscriberConfig, TranscriberConfig } from "../types";
import { isSafari, isChrome, isFirefox } from "react-device-detect";
import { Buffer } from "buffer";

const VOCODE_API_URL = "api.vocode.dev";
const DEFAULT_CHUNK_SIZE = 2048;

export const useConversation = (
  config: ConversationConfig | SelfHostedConversationConfig
): {
  status: ConversationStatus;
  start: () => Promise<void>;
  stop: () => void;
  error: Error | undefined;
  active: boolean;
  setActive: (active: boolean) => void;
  toggleActive: () => void;
  analyserNode: AnalyserNode | undefined;
  transcripts: Transcript[];
  currentSpeaker: CurrentSpeaker;
} => {
  const [audioContext, setAudioContext] = React.useState<AudioContext>();
  const [audioAnalyser, setAudioAnalyser] = React.useState<AnalyserNode>();
  const [audioQueue, setAudioQueue] = React.useState<Buffer[]>([]);
  const [currentSpeaker, setCurrentSpeaker] =
    React.useState<CurrentSpeaker>("none");
  const [processing, setProcessing] = React.useState<Boolean>(false);
  const [recorder, setRecorder] = React.useState<IMediaRecorder>();
  const [socket, setSocket] = React.useState<WebSocket>();
  const [status, setStatus] = React.useState<ConversationStatus>("idle");
  const [error, setError] = React.useState<Error>();
  const [transcripts, setTranscripts] = React.useState<Transcript[]>([]);
  const [active, setActive] = React.useState(true);
  const toggleActive = () => setActive(!active);
  const [audioStream, setAudioStream] = React.useState<MediaStream>();

  // get audio context and metadata about user audio
  React.useEffect(() => {
    const audioContext = new AudioContext();
    setAudioContext(audioContext);
    const audioAnalyser = audioContext.createAnalyser();
    setAudioAnalyser(audioAnalyser);
  }, []);

  const recordingDataListener = ({ data }: { data: Blob }) => {
    blobToBase64(data).then((base64Encoded: string | null) => {
      if (!base64Encoded) return;
      const audioMessage: AudioMessage = {
        type: "websocket_audio",
        data: base64Encoded,
      };
      socket?.readyState === WebSocket.OPEN &&
        socket.send(stringify(audioMessage));
    });
  };
  
  // once the conversation is connected, stream the microphone audio into the socket
  React.useEffect(() => {
    if (!recorder || !socket) return;
    if (status === "connected") {
      if (active)
        recorder.addEventListener("dataavailable", recordingDataListener);
      else
        recorder.removeEventListener("dataavailable", recordingDataListener);
    }
  }, [recorder, socket, status, active]);

  // accept wav audio from webpage
  React.useEffect(() => {
    const registerWav = async () => {
      await register(await connect());
    };
    registerWav().catch(console.error);
  }, []);

  // play audio that is queued
  React.useEffect(() => {
    const playArrayBuffer = (arrayBuffer: ArrayBuffer) => {
      audioContext &&
        audioAnalyser &&
        audioContext.decodeAudioData(arrayBuffer, (buffer) => {
          const source = audioContext.createBufferSource();
          source.buffer = buffer;
          source.connect(audioContext.destination);
          source.connect(audioAnalyser);
          setCurrentSpeaker("agent");
          source.start(0);
          source.onended = () => {
            if (audioQueue.length <= 0) {
              setCurrentSpeaker("user");
            }
            setProcessing(false);
          };
        });
    };
    if (!processing && audioQueue.length > 0) {
      setProcessing(true);
      const audio = audioQueue.shift();
      audio &&
        fetch(URL.createObjectURL(new Blob([audio])))
          .then((response) => response.arrayBuffer())
          .then(playArrayBuffer);
    }
  }, [audioQueue, processing]);

  const stopConversation = (error?: Error) => {
    setAudioQueue([]);
    setCurrentSpeaker("none");
    if (error) {
      setError(error);
      setStatus("error");
    } else {
      setStatus("idle");
    }
    if (recorder) { recorder.stop() }
    if (audioStream) { audioStream.getTracks().forEach((track) => track.stop()) }
    if (socket) {
      const stopMessage: StopMessage = {
        type: "websocket_stop",
      };
      socket.send(stringify(stopMessage));
      socket.close();
    }
  };

  const getBackendUrl = async () => {
    if ("backendUrl" in config) {
      return config.backendUrl;
    } else if ("vocodeConfig" in config) {
      const baseUrl = config.vocodeConfig.baseUrl || VOCODE_API_URL;
      return `wss://${baseUrl}/conversation?key=${config.vocodeConfig.apiKey}`;
    } else {
      throw new Error("Invalid config");
    }
  };

  const getStartMessage = (
    config: ConversationConfig,
    inputAudioMetadata: { samplingRate: number; audioEncoding: AudioEncoding },
    outputAudioMetadata: { samplingRate: number; audioEncoding: AudioEncoding }
  ): StartMessage => {
    let transcriberConfig: TranscriberConfig = Object.assign(
      config.transcriberConfig,
      inputAudioMetadata
    );
    if (isSafari && transcriberConfig.type === "transcriber_deepgram") {
      (transcriberConfig as DeepgramTranscriberConfig).downsampling = 2;
    }

    return {
      type: "websocket_start",
      transcriberConfig: Object.assign(
        config.transcriberConfig,
        inputAudioMetadata
      ),
      agentConfig: config.agentConfig,
      synthesizerConfig: Object.assign(
        config.synthesizerConfig,
        outputAudioMetadata
      ),
      conversationId: config.vocodeConfig.conversationId,
    };
  };

  const getAudioConfigStartMessage = (
    inputAudioMetadata: { samplingRate: number; audioEncoding: AudioEncoding },
    outputAudioMetadata: { samplingRate: number; audioEncoding: AudioEncoding },
    chunkSize: number | undefined,
    downsampling: number | undefined,
    conversationId: string | undefined,
    subscribeTranscript: boolean | undefined
  ): AudioConfigStartMessage => ({
    type: "websocket_audio_config_start",
    inputAudioConfig: {
      samplingRate: inputAudioMetadata.samplingRate,
      audioEncoding: inputAudioMetadata.audioEncoding,
      chunkSize: chunkSize || DEFAULT_CHUNK_SIZE,
      downsampling,
    },
    outputAudioConfig: {
      samplingRate: outputAudioMetadata.samplingRate,
      audioEncoding: outputAudioMetadata.audioEncoding,
    },
    conversationId,
    subscribeTranscript,
  });

  const startConversation = async () => {
    if (!audioContext || !audioAnalyser) {
      const audioError = new Error("Audio context not initialized");
      console.log(audioError);
      stopConversation(audioError);
      return;
    } 
    setStatus("connecting");

    if (!isSafari && !isChrome && !isFirefox) {
      stopConversation(new Error("Unsupported browser"));
      return;
    }

    if (audioContext.state === "suspended") {
      console.log("Resuming audio context");
      audioContext.resume();
    }

    const backendUrl = await getBackendUrl();

    setError(undefined);
    const socket = new WebSocket(backendUrl);
    // let error: Error | undefined;
    socket.onerror = (event) => {
      console.error(event);
      const socketError = new Error("See console for error details");
      setError(socketError);
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "websocket_audio") {
        setAudioQueue((prev) => [...prev, Buffer.from(message.data, "base64")]);
      } else if (message.type === "websocket_ready") {
        setStatus("connected");
      } else if (message.type == "websocket_transcript") {
        setTranscripts((prev) => {
          let last = prev.pop();
          if (last && last.sender === message.sender) {
            prev.push({
              sender: message.sender,
              text: last.text + " " + message.text,
            });
          } else {
            if (last) {
              prev.push(last);
            }
            prev.push({
              sender: message.sender,
              text: message.text,
            });
          }
          return prev;
        });
      } else {
        console.log("Unknown message type", message.type);
        console.log(message)
      }
    };
    socket.onclose = () => {
      stopConversation(error);
    };
    setSocket(socket);

    // wait for socket to be ready
    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          clearInterval(interval);
          resolve(null);
        }
      }, 100);
    });

    console.log("Socket ready")

    try {
      const trackConstraints: MediaTrackConstraints = {
        echoCancellation: true,
      };
      if (config.audioDeviceConfig.inputDeviceId) {
        console.log(
          "Using input device",
          config.audioDeviceConfig.inputDeviceId
        );
        trackConstraints.deviceId = config.audioDeviceConfig.inputDeviceId;
      }
      const currAudioStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: trackConstraints,
      });
      setAudioStream(currAudioStream);
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        alert(
          "Allowlist this site at chrome://settings/content/microphone to talk to the bot."
        );
        error = new Error("Microphone access denied");
      }
      console.error(error);
      stopConversation(error as Error);
      return;
    }
    if (!audioStream) {
      stopConversation(new Error("No audio stream"));
      return;
    }
    const micSettings = audioStream.getAudioTracks()[0].getSettings();
    console.log(micSettings);
    const inputAudioMetadata = {
      samplingRate: micSettings.sampleRate || audioContext.sampleRate,
      audioEncoding: "linear16" as AudioEncoding,
    };
    console.log("Input audio metadata", inputAudioMetadata);

    const outputAudioMetadata = {
      samplingRate:
        config.audioDeviceConfig.outputSamplingRate || audioContext.sampleRate,
      audioEncoding: "linear16" as AudioEncoding,
    };
    console.log("Output audio metadata", inputAudioMetadata);

    let startMessage: StartMessage | AudioConfigStartMessage;
    if (
      [
        "transcriberConfig",
        "agentConfig",
        "synthesizerConfig",
        "vocodeConfig",
      ].every((key) => key in config)
    ) {
      startMessage = getStartMessage(
        config as ConversationConfig,
        inputAudioMetadata,
        outputAudioMetadata
      );
    } else {
      console.log("Using audio config start message")
      const selfHostedConversationConfig =
        config as SelfHostedConversationConfig;
      startMessage = getAudioConfigStartMessage(
        inputAudioMetadata,
        outputAudioMetadata,
        selfHostedConversationConfig.chunkSize,
        selfHostedConversationConfig.downsampling,
        selfHostedConversationConfig.conversationId,
        selfHostedConversationConfig.subscribeTranscript
      );
    }
    console.log("Sending", startMessage)
    socket.send(stringify(startMessage));
    console.log("Access to microphone granted");
    console.log(startMessage);

    let recorderToUse = recorder;
    if (recorderToUse && recorderToUse.state === "paused") {
      recorderToUse.resume();
    } else if (!recorderToUse) {
      recorderToUse = new MediaRecorder(audioStream, {
        mimeType: "audio/wav",
      });
      setRecorder(recorderToUse);
    }

    let timeSlice: number;
    if ("transcriberConfig" in startMessage) {
      timeSlice = Math.round(
        (1000 * startMessage.transcriberConfig.chunkSize) /
          startMessage.transcriberConfig.samplingRate
      );
    } else if ("timeSlice" in config && config.timeSlice) {
      timeSlice = config.timeSlice;
    } else {
      timeSlice = 10;
    }

    if (recorderToUse.state === "recording") {
      // When the recorder is in the recording state, see:
      // https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/state
      // which is not expected to call `start()` according to:
      // https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/start.
      console.log("Recorder already recording")
      return;
    }
    try {
      recorderToUse.start(timeSlice);
    } catch (error) {
      console.error(error);
      stopConversation(error as Error);
      return;
    }
  };

  return {
    status,
    start: startConversation,
    stop: stopConversation,
    error,
    toggleActive,
    active,
    setActive,
    analyserNode: audioAnalyser,
    transcripts,
    currentSpeaker,
  };
};
