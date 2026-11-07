export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const statuses = ["pending", "in_progress", "completed", "declined", "cancelled", "expired", "failed"] as const;
export type RequestStatus = typeof statuses[number];
export const inputKinds = ["answer", "question", "progress", "decline", "failure"] as const;
export type InputKind = typeof inputKinds[number];
export type Disposition = "accepted" | "stale" | "late";

export interface SubmitRequest {
  idempotencyKey: string;
  requester: string;
  recipient: string;
  prompt: string;
  context?: JsonValue;
  responseSchema?: JsonObject;
  scope?: string;
  correlation?: JsonObject;
  deadlineAt?: string | null;
}

export interface HumanRequest {
  id: string;
  revision: number;
  requester: string;
  recipient: string;
  prompt: string;
  context: JsonValue;
  responseSchema: JsonObject | null;
  scope: string | null;
  correlation: JsonObject;
  status: RequestStatus;
  deadlineAt: string | null;
  createdAt: string;
  updatedAt: string;
  result: JsonValue;
}

export interface RespondInput {
  inputId: string;
  actor: string;
  kind: InputKind;
  revision: number;
  payload: JsonValue;
}

export interface HumanInput extends RespondInput {
  requestId: string;
  disposition: Disposition;
  createdAt: string;
}

export interface HumanEvent {
  sequence: number;
  requestId: string;
  type: "request.created" | "request.amended" | "request.cancelled" | "request.expired" | "input.received";
  createdAt: string;
  request: HumanRequest;
  input: HumanInput | null;
}

export interface InputReceipt {
  input: HumanInput;
  request: HumanRequest;
}

export interface AmendRequest {
  expectedRevision: number;
  prompt?: string;
  context?: JsonValue;
  responseSchema?: JsonObject | null;
  deadlineAt?: string | null;
}

export class HarnessError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "HarnessError";
  }
}
