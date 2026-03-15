export type ContextOpenVikingConfig = {
  mode?: "local" | "remote";
  configPath?: string;
  port?: number;
  baseUrl?: string;
  agentId?: string;
  apiKey?: string;
  timeoutMs?: number;
  freshTailMessages?: number;
  autoRecallEnabled?: boolean;
  resourceRecallEnabled?: boolean;
  searchEscalationEnabled?: boolean;
  recallLimit?: number;
  recallScoreThreshold?: number;
};

export type RequiredContextOpenVikingConfig = Required<ContextOpenVikingConfig>;

export type FindResultItem = {
  uri: string;
  level?: number;
  abstract?: string;
  overview?: string;
  category?: string;
  score?: number;
  match_reason?: string;
};

export type FindResult = {
  memories?: FindResultItem[];
  resources?: FindResultItem[];
  skills?: FindResultItem[];
  total?: number;
};

export type ContextPluginState = {
  ovSessionId: string | null;
  mirroredMessageCount: number;
  lastCommittedMessageCount: number;
  updatedAt: string;
};

export type RecallScope = "session" | "memory" | "resource" | "skill";

export type SessionSyncResult = {
  state: ContextPluginState;
  importedCount: number;
};

export type MessageLike = Record<string, unknown>;
