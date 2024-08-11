import type { TranscriberConfig } from "./transcriber";
import type { AgentConfig } from "./agent";
import type { SynthesizerConfig } from "./synthesizer";
import { AudioEncoding } from "./audioEncoding";

export type WebSocketMessageType =
  | "websocket_start"
  | "websocket_audio"
  | "websocket_transcript"
  | "websocket_ready"
  | "websocket_stop"
  | "websocket_audio_config_start"
  | "websocket_ptt_start"
  | "websocket_ptt_stop"
  | "websocket_vad_started_speaking"
  | "websocket_vad_stopped_speaking";

export interface WebSocketMessage {
  type: WebSocketMessageType;
}

export interface StartMessage extends WebSocketMessage {
  type: "websocket_start";
  transcriberConfig: TranscriberConfig;
  agentConfig: AgentConfig;
  synthesizerConfig: SynthesizerConfig;
  conversationId?: string;

  firstMessage?: string;
  systemPrompt?: string;
}

export interface InputAudioConfig {
  samplingRate: number;
  audioEncoding: AudioEncoding;
  chunkSize: number;
  downsampling?: number;
}

export interface OutputAudioConfig {
  samplingRate: number;
  audioEncoding: AudioEncoding;
}

export interface AudioConfigStartMessage extends WebSocketMessage {
  type: "websocket_audio_config_start";
  inputAudioConfig: InputAudioConfig;
  outputAudioConfig: OutputAudioConfig;
  conversationId?: string;
  subscribeTranscript?: boolean;

  firstMessage?: string;
  systemPrompt?: string;
}

export interface AudioMessage extends WebSocketMessage {
  type: "websocket_audio";
  data: string;
}

export interface TranscriptMessage extends WebSocketMessage {
  type: "websocket_transcript";
  text: string;
  sender: string;
  timestamp: string;
}

export interface ReadyMessage extends WebSocketMessage {
  type: "websocket_ready";
}

export interface StopMessage extends WebSocketMessage {
  type: "websocket_stop";
}

export interface PttStartMessage extends WebSocketMessage {
  type: "websocket_ptt_start";
} 

export interface PttStopMessage extends WebSocketMessage {
  type: "websocket_ptt_stop";
}

export interface VADStartedSpeakingMessage extends WebSocketMessage {
  type: "websocket_vad_started_speaking";
}

export interface VADStoppedSpeakingMessage extends WebSocketMessage {
  type: "websocket_vad_stopped_speaking";
}
