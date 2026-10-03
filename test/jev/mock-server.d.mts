// Type declarations for the Phase 0 Jev contract mock (mock-server.mjs).
import type { Server } from "node:http";

export declare const TEST_TOKEN: string;
export declare const ACCEPTED_MODELS: string[];
export declare const RANGE_QUALITY: string[];

export type MockScenario = {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
};

export declare function startJeveMock(options?: {
  port?: number;
  validToken?: string;
  allowAnonymous?: boolean;
  scenario?: string;
  extraScenarios?: Record<string, MockScenario>;
}): Promise<{
  port: number;
  url: string;
  server: Server;
  close: () => Promise<void>;
}>;
