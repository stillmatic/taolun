import {
  IMediaRecorder,
  MediaRecorder,
  register,
} from "extendable-media-recorder";
import { connect } from "extendable-media-recorder-wav-encoder";
import React, { useCallback, useEffect, useReducer, useRef } from "react";
import {
  ConversationConfig,
  ConversationStatus,
  CurrentSpeaker,
  SelfHostedConversationConfig,
  Transcript,
} from "../types/conversation";
import { blobToBase64, base64BufferToArrayBuffer, stringify } from "../utils";
import { AudioEncoding } from "../types/taolun/audioEncoding";
import {
  AudioConfigStartMessage,
  AudioMessage,
  StartMessage,
  StopMessage,
  PttStartMessage,
  PttStopMessage,
  VADStartedSpeakingMessage,
  VADStoppedSpeakingMessage,
} from "../types/taolun/websocket";
import { DeepgramTranscriberConfig, TranscriberConfig } from "../types";
import { isSafari, isChrome, isFirefox } from "react-device-detect";
import { Buffer } from "buffer";
import { MicVAD, RealTimeVADOptions } from "@ricky0123/vad-web";

const VOCODE_API_URL = "api.vocode.dev";
const DEFAULT_CHUNK_SIZE = 2048;

const audioContext = new AudioContext();
const audioAnalyser = audioContext.createAnalyser();
let nextStartTime = audioContext.currentTime;

type ConversationState = {
  status: ConversationStatus;
  error: Error | undefined;
  active: boolean;
  isPTTActive: boolean;
  currentSpeaker: CurrentSpeaker;
  transcripts: Transcript[];
};

type ConversationAction =
  | { type: "SET_STATUS"; payload: ConversationStatus }
  | { type: "SET_ERROR"; payload: Error | undefined }
  | { type: "SET_ACTIVE"; payload: boolean }
  | { type: "TOGGLE_ACTIVE" }
  | { type: "SET_PTT_ACTIVE"; payload: boolean }
  | { type: "SET_CURRENT_SPEAKER"; payload: CurrentSpeaker }
  | { type: "ADD_TRANSCRIPT"; payload: Transcript }
  | { type: "UPDATE_TRANSCRIPTS"; payload: Transcript };

const conversationReducer = (
  state: ConversationState,
  action: ConversationAction
): ConversationState => {
  switch (action.type) {
    case "SET_STATUS":
      return { ...state, status: action.payload };
    case "SET_ERROR":
      return { ...state, error: action.payload };
    case "SET_ACTIVE":
      return { ...state, active: action.payload };
    case "TOGGLE_ACTIVE":
      return { ...state, active: !state.active };
    case "SET_PTT_ACTIVE":
      return { ...state, isPTTActive: action.payload };
    case "SET_CURRENT_SPEAKER":
      return { ...state, currentSpeaker: action.payload };
    case "ADD_TRANSCRIPT":
      return { ...state, transcripts: [...state.transcripts, action.payload] };
    case "UPDATE_TRANSCRIPTS":
      const newTranscripts = [...state.transcripts];
      const lastTranscript = newTranscripts[newTranscripts.length - 1];

      if (lastTranscript && lastTranscript.sender === action.payload.sender) {
        // Update the last transcript if the sender is the same
        newTranscripts[newTranscripts.length - 1] = {
          ...lastTranscript,
          text: lastTranscript.text + " " + action.payload.text,
          timestamp: action.payload.timestamp,
        };
      } else {
        // Add a new transcript if the sender is different or there are no transcripts
        newTranscripts.push(action.payload);
      }

      return { ...state, transcripts: newTranscripts };
    default:
      return state;
  }
};

const initialState: ConversationState = {
  status: "idle",
  error: undefined,
  active: true,
  isPTTActive: false,
  currentSpeaker: "none",
  transcripts: [],
};

export const useConversation = (
  config: ConversationConfig | SelfHostedConversationConfig
): {
  status: ConversationStatus;
  start: () => Promise<void>;
  stop: () => void;
  startPTT: () => void;
  stopPTT: () => void;
  isPTTActive: boolean;
  error: Error | undefined;
  active: boolean;
  setActive: (active: boolean) => void;
  toggleActive: () => void;
  analyserNode: AnalyserNode | undefined;
  transcripts: Transcript[];
  currentSpeaker: CurrentSpeaker;
} => {
  const [recorder, setRecorder] = React.useState<IMediaRecorder>();
  const [socket, setSocket] = React.useState<WebSocket>();
  const [audioStream, setAudioStream] = React.useState<MediaStream>();
  const totalDurationRef = React.useRef(0);
  const [vad, setVad] = React.useState<MicVAD | null>(null);
  const [userSpeakingBool, setUserSpeakingBool] = React.useState(false);

  const setActive = (active: boolean) =>
    dispatch({ type: "SET_ACTIVE", payload: active });
  const setIsPTTActive = (isPTTActive: boolean) =>
    dispatch({ type: "SET_PTT_ACTIVE", payload: isPTTActive });
  const setCurrentSpeaker = (currentSpeaker: CurrentSpeaker) =>
    dispatch({ type: "SET_CURRENT_SPEAKER", payload: currentSpeaker });
  const setStatus = (status: ConversationStatus) =>
    dispatch({ type: "SET_STATUS", payload: status });
  const setError = (error: Error | undefined) =>
    dispatch({ type: "SET_ERROR", payload: error });
  const [state, dispatch] = React.useReducer(conversationReducer, initialState);

  const logIfVerbose = (...message: any[]) => {
    if (config.verbose) {
      console.log(message);
    }
  };

  const [isUserSpeaking, updateIsUserSpeaking] = useReducer(
    (state: boolean, isSpeechProbability: number) => {
      const newState = isSpeechProbability > 0.6;
      setUserSpeakingBool(newState);
      // logIfVerbose(`Speech probability: ${isSpeechProbability}, isUserSpeaking: ${newState}`);
      return newState;
    },
    false
  );

  // Create a ref to hold the latest isUserSpeaking value
  const isUserSpeakingRef = useRef(isUserSpeaking);

  // Update the ref whenever isUserSpeaking changes
  useEffect(() => {
    isUserSpeakingRef.current = isUserSpeaking;
    logIfVerbose(`isUserSpeaking updated: ${isUserSpeaking}`);
    if (isUserSpeaking) {
      const vadStartMessage: VADStartedSpeakingMessage = {
        type: "websocket_vad_started_speaking",
      };
      socket?.readyState === WebSocket.OPEN &&
        socket.send(stringify(vadStartMessage));
    } else {
      const vadStopMessage: VADStoppedSpeakingMessage = {
        type: "websocket_vad_stopped_speaking",
      };
      socket?.readyState === WebSocket.OPEN &&
        socket.send(stringify(vadStopMessage));
    }
  }, [isUserSpeaking]);

  const startPTT = useCallback(() => {
    if (state.status !== "connected" || !recorder || !socket) {
      console.error("Cannot start PTT: conversation not connected");
      return;
    }
    logIfVerbose("Starting PTT");

    setIsPTTActive(true);
    vad?.start();
    const startMessage: PttStartMessage = {
      type: "websocket_ptt_start",
    };
    socket?.readyState === WebSocket.OPEN &&
      socket.send(stringify(startMessage));
    logIfVerbose("PTT started");
  }, [state.status, recorder, socket, vad, logIfVerbose]);

  const stopPTT = useCallback(() => {
    if (!state.isPTTActive || !recorder) {
      console.error("Cannot stop PTT: PTT not active");
      return;
    }
    vad?.pause();
    logIfVerbose("Stopping PTT");
    setIsPTTActive(false);
    const stopMessage: PttStopMessage = {
      type: "websocket_ptt_stop",
    };
    socket?.readyState === WebSocket.OPEN &&
      socket.send(stringify(stopMessage));
    logIfVerbose("PTT stopped");
  }, [state.isPTTActive, recorder, vad, socket, logIfVerbose]);

  const recordingDataListener = useCallback(({ data }: { data: Blob }) => {
    if (!state.isPTTActive || !isUserSpeakingRef.current) return;

    blobToBase64(data).then((base64Encoded: string | null) => {
      if (!base64Encoded) return;
      const audioMessage: AudioMessage = {
        type: "websocket_audio",
        data: base64Encoded,
      };
      socket?.readyState === WebSocket.OPEN &&
        socket.send(stringify(audioMessage));
    });
  }, [state.isPTTActive, isUserSpeakingRef, socket]);

  // once the conversation is connected, stream the microphone audio into the socket
  React.useEffect(() => {
    if (!recorder || !socket || !vad) return;
    if (state.status === "connected") {
      if (state.active && state.isPTTActive) {
        vad.start();
        recorder.addEventListener("dataavailable", recordingDataListener);
      } else {
        vad.pause();
        recorder.removeEventListener("dataavailable", recordingDataListener);
      }
    }

    return () => {
      vad.pause();
      recorder.removeEventListener("dataavailable", recordingDataListener);
    };
  }, [recorder, socket, state.status, state.active, state.isPTTActive, vad]);

  // (Cinjon) TODO: This probably doesn't work correctly now.
  React.useEffect(() => {
    if (
      state.currentSpeaker === "agent" &&
      audioContext.currentTime > totalDurationRef.current
    ) {
      setCurrentSpeaker("user");
    } else if (
      state.currentSpeaker === "user" &&
      audioContext.currentTime < totalDurationRef.current
    ) {
      setCurrentSpeaker("agent");
    }
  }, [state.currentSpeaker, audioContext]);

  // accept wav audio from webpage
  React.useEffect(() => {
    const registerWav = async () => {
      await register(await connect());
    };
    registerWav().catch(console.error);
  }, []);

  const playArrayBuffer = React.useCallback(
    (arrayBuffer: ArrayBuffer) => {
      audioContext &&
        audioAnalyser &&
        audioContext.decodeAudioData(arrayBuffer, (buffer) => {
          const source = audioContext.createBufferSource();
          source.buffer = buffer;
          source.connect(audioContext.destination);
          source.connect(audioAnalyser);

          const duration = buffer.duration;
          const currentTime = audioContext.currentTime;
          const scheduledTime = Math.max(nextStartTime, currentTime);

          // Use a gain node for a smooth transition
          const gainNode = audioContext.createGain();
          gainNode.gain.setValueAtTime(0, scheduledTime);
          gainNode.gain.linearRampToValueAtTime(1, scheduledTime + 0.1); // Quick fade in
          source.connect(gainNode);
          gainNode.connect(audioContext.destination);

          source.start(scheduledTime);

          // Fade out before the buffer ends to prevent clicks
          gainNode.gain.setValueAtTime(
            1,
            nextStartTime + buffer.duration - 0.1
          );
          gainNode.gain.linearRampToValueAtTime(
            0,
            nextStartTime + buffer.duration
          );

          nextStartTime = scheduledTime + duration;
          // source.start(currentTotalDuration);
          totalDurationRef.current = nextStartTime;
        });
    },
    [audioContext, audioAnalyser]
  );

  const stopConversation = (error?: Error) => {
    setCurrentSpeaker("none");
    if (error) {
      setError(error);
      console.error(error);
      setStatus("error");
    } else {
      setStatus("idle");
    }
    if (recorder) {
      recorder.stop();
    }
    if (audioStream) {
      audioStream.getTracks().forEach((track) => track.stop());
    }
    if (state.isPTTActive) {
      stopPTT();
    }
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
    subscribeTranscript: boolean | undefined,
    firstMessage: string | undefined,
    systemPrompt: string | undefined
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
    firstMessage,
    systemPrompt,
  });

  const startConversation = async () => {
    if (!audioContext || !audioAnalyser) {
      const audioError = new Error("Audio context not initialized");
      stopConversation(audioError);
      return;
    }
    setStatus("connecting");

    if (!isSafari && !isChrome && !isFirefox) {
      stopConversation(new Error("Unsupported browser"));
      return;
    }

    if (audioContext.state === "suspended") {
      logIfVerbose("Resuming audio context");
      audioContext.resume();
    }

    const backendUrl = await getBackendUrl();

    setError(undefined);
    const socket = new WebSocket(backendUrl);
    // let error: Error | undefined;
    socket.onerror = (event) => {
      console.error(event);
      const socketError = new Error("Socket error, see console for details");
      setError(socketError);
    };

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "websocket_audio") {
        const audio = Buffer.from(message.data, "base64");
        const audioArrayBuffer = base64BufferToArrayBuffer(audio);
        playArrayBuffer(audioArrayBuffer);
        setCurrentSpeaker("agent");
      } else if (message.type === "websocket_ready") {
        setStatus("connected");
      } else if (message.type == "websocket_transcript") {
        const transcriptMsg = message as Transcript;

        dispatch({
          type: "UPDATE_TRANSCRIPTS",
          payload: {
            sender: transcriptMsg.sender,
            text: transcriptMsg.text,
            timestamp: transcriptMsg.timestamp,
          },
        });
      } else {
        console.error("Unknown message type", message.type);
        logIfVerbose(message);
      }
    };
    socket.onclose = () => {
      stopConversation(state.error);
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

    logIfVerbose("Socket ready");
    console.log("Using config", config);
    let currAudioStream: MediaStream | undefined;
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
      } else {
        console.warn("No input device specified");
      }
      currAudioStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: trackConstraints,
      });
      logIfVerbose("Got audio stream", currAudioStream);
      setAudioStream(currAudioStream);
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        alert(
          "Allowlist this site at chrome://settings/content/microphone to talk to the bot."
        );
        const micError = new Error("Microphone access denied");
        stopConversation(micError);
      } else {
        stopConversation(error as Error);
        return;
      }
    }
    if (!currAudioStream) {
      stopConversation(new Error("No audio stream"));
      return;
    }

    const audioTracks = currAudioStream.getAudioTracks();
    logIfVerbose("Audio tracks", audioTracks);
    if (audioTracks.length === 0) {
      stopConversation(new Error("No audio tracks"));
      return;
    }
    const micSettings = currAudioStream.getAudioTracks()[0].getSettings();
    logIfVerbose(micSettings);
    const inputAudioMetadata = {
      samplingRate: micSettings.sampleRate || audioContext.sampleRate,
      audioEncoding: "linear16" as AudioEncoding,
    };
    logIfVerbose("Input audio metadata", inputAudioMetadata);

    const outputAudioMetadata = {
      samplingRate:
        config.audioDeviceConfig.outputSamplingRate || audioContext.sampleRate,
      audioEncoding: "linear16" as AudioEncoding,
    };
    logIfVerbose("Output audio metadata", inputAudioMetadata);

    // initialize VAD
    const vadOptions: Partial<RealTimeVADOptions> = {
      stream: currAudioStream,
      ortConfig: (ort) => {
        ort.env.wasm.wasmPaths = {
          "ort-wasm-simd.wasm": "/ort-wasm-simd.wasm",
        };
      },
      onFrameProcessed: (probs) => {
        updateIsUserSpeaking(probs.isSpeech);
      },
      onSpeechStart: () => {
        logIfVerbose(
          "User started speaking",
          "userspeaking" + isUserSpeaking,
          state.active
        );
      },
      onSpeechEnd: () => {
        logIfVerbose(
          "User stopped speaking",
          "userspeaking" + isUserSpeaking,
          state.active
        );
      },
      onVADMisfire: () => {
        logIfVerbose("VAD misfire");
      },
    };

    try {
      const newVad = await MicVAD.new(vadOptions);
      logIfVerbose("VAD initialized", vadOptions);
      setVad(newVad);
      vad?.start();
      logIfVerbose("VAD started");
    } catch (error) {
      console.error("Error initializing VAD:", error);
      stopConversation(error as Error);
      return;
    }

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
      logIfVerbose("Using audio config start message");
      const selfHostedConversationConfig =
        config as SelfHostedConversationConfig;
      startMessage = getAudioConfigStartMessage(
        inputAudioMetadata,
        outputAudioMetadata,
        selfHostedConversationConfig.chunkSize,
        selfHostedConversationConfig.downsampling,
        selfHostedConversationConfig.conversationId,
        selfHostedConversationConfig.subscribeTranscript,
        selfHostedConversationConfig.firstMessage,
        selfHostedConversationConfig.systemPrompt
      );
    }
    logIfVerbose("Sending start message", startMessage);
    socket.send(stringify(startMessage));
    logIfVerbose("Access to microphone granted");

    let recorderToUse = recorder;
    if (!recorderToUse || recorderToUse.state === "inactive") {
      recorderToUse = new MediaRecorder(currAudioStream, {
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
      console.error("Recorder already recording");
      return;
    }
    try {
      recorderToUse.start(timeSlice);
    } catch (error) {
      stopConversation(error as Error);
      return;
    }
  };

  React.useEffect(() => {
    return () => {
      vad?.destroy();
    };
  }, [vad]);

  return {
    ...state,
    start: startConversation,
    stop: stopConversation,
    startPTT,
    stopPTT,
    toggleActive: () => dispatch({ type: "TOGGLE_ACTIVE" }),
    setActive: (active: boolean) =>
      dispatch({ type: "SET_ACTIVE", payload: active }),
    analyserNode: audioAnalyser,
  };
};
