export type LaneStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed";

export type LaneType = "write" | "read_review";

export type ModelTier = "fast" | "balanced" | "deep";

export type MessageType =
  | "QUESTION"
  | "CLAIM"
  | "EVIDENCE"
  | "APPROVAL_REQUEST"
  | "FAILURE"
  | "COMPLETED";

export interface Lane {
  lane_id: string;
  owned_paths: string[];
  lane_type: LaneType;
  model: ModelTier;
  depends_on: string[];
  status: LaneStatus;
  worktree_path: string;
  attempt_count: number;
  original_brief: string;
  plan_revision_id: string | null;
}

export interface GateResult {
  allowed: boolean;
  reason: string;
}
