import { AgentConfig } from "./taolun/agent";
import { SynthesizerConfig } from "./taolun/synthesizer";
import { TranscriberConfig } from "./taolun/transcriber";
import { AudioEncoding } from "./taolun/audioEncoding";

export type ConversationStatus = "idle" | "connecting" | "connected" | "error";

export type CurrentSpeaker = "agent" | "user" | "none";

export type AudioDeviceConfig = {
  inputDeviceId?: string;
  outputDeviceId?: string;
  outputSamplingRate?: number;
};

export type VocodeConfig = {
  apiKey: string;
  conversationId?: string;
  baseUrl?: string;
};

export type ConversationConfig = {
  audioDeviceConfig: AudioDeviceConfig;
  transcriberConfig: Omit<TranscriberConfig, "samplingRate" | "audioEncoding">;
  agentConfig: AgentConfig;
  synthesizerConfig: Omit<SynthesizerConfig, "samplingRate" | "audioEncoding">;
  vocodeConfig: VocodeConfig;
  verbose?: boolean;
  shouldUseVAD?: boolean;
};

export type SelfHostedConversationConfig = {
  backendUrl: string;
  audioDeviceConfig: AudioDeviceConfig;
  apiKey?: string;
  conversationId?: string;
  timeSlice?: number;
  chunkSize?: number;
  downsampling?: number;
  subscribeTranscript?: boolean;
  verbose?: boolean;
  metadata?: Record<string, string>;
  shouldUseVAD?: boolean;

  firstMessage?: string;
  systemPrompt?: string;
};

export type AudioMetadata = {
  samplingRate: number;
  audioEncoding: AudioEncoding;
};

export type Transcript = {
  sender: string;
  text: string;
  timestamp: number;
};
