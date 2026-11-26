export type AgentJobMode = "single" | "heal" | "explore";
export type AgentJobStage =
  | "queued"
  | "planning"
  | "generating"
  | "running"
  | "healing"
  | "completed"
  | "failed";

export interface InteractiveElement {
  tag: string;
  type: string | null;
  role: string | null;
  label: string | null;
  placeholder: string | null;
  text: string | null;
  testId: string | null;
  id: string | null;
  playwrightLocator: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  ariaSnapshot: string;
  interactiveElements: InteractiveElement[];
}

export interface AgentLogEntry {
  at: string;
  stage: AgentJobStage;
  message: string;
}

export interface DiscoveredScenario {
  title: string;
  description: string;
  steps: string[];
  expectedResult: string;
  priority: "low" | "medium" | "high";
}

export interface TestAgentJobRecord {
  id: string;
  projectId: string;
  testcaseId: string | null;
  mode: AgentJobMode;
  stage: AgentJobStage;
  targetUrl: string;
  instructions: string | null;
  attempt: number;
  maxAttempts: number;
  planJson: Record<string, unknown>;
  logs: AgentLogEntry[];
  discoveredScenarios: DiscoveredScenario[];
  resultScriptId: string | null;
  resultVersionId: string | null;
  resultRunId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationAuthConfigSummary {
  loginUrl: string | null;
  username: string | null;
  hasPassword: boolean;
  hasStorageState: boolean;
  updatedAt: string | null;
}

export interface DecryptedAutomationAuth {
  loginUrl: string | null;
  username: string | null;
  password: string | null;
  storageStateJson: string | null;
}
