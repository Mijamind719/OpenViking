declare module "openclaw/plugin-sdk" {
  export type ToolContentItem = {
    type: string;
    text?: string;
  };

  export type ToolExecutionResult = {
    content: ToolContentItem[];
    details?: Record<string, unknown>;
  };

  export type AgentMessage = Record<string, unknown>;

  export type AnyAgentTool = {
    name: string;
    label?: string;
    description?: string;
    parameters?: unknown;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
    ) => Promise<ToolExecutionResult> | ToolExecutionResult;
  };

  export type PluginLogger = {
    info?: (msg: string) => void;
    warn: (msg: string) => void;
    error?: (msg: string) => void;
    debug?: (msg: string) => void;
  };

  export type ContextEngineFactory = () => unknown | Promise<unknown>;

  export type OpenClawPluginApi = {
    id: string;
    name: string;
    version?: string;
    description?: string;
    source: string;
    config: Record<string, unknown>;
    pluginConfig?: Record<string, unknown>;
    runtime: Record<string, unknown>;
    logger: PluginLogger;
    registerTool: (tool: AnyAgentTool, opts?: { name?: string }) => void;
    registerService: (service: {
      id: string;
      start?: () => Promise<void> | void;
      stop?: () => Promise<void> | void;
    }) => void;
    registerContextEngine: (id: string, factory: ContextEngineFactory) => void;
    resolvePath: (input: string) => string;
  };
}
