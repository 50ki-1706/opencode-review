// Local HTTP mock for the GitHub REST calls a pipeline run makes. Not named
// *.test.* so the Node test runner never executes it directly.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";

export type MockRequest = {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
};

export type MockResponse = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Destroy the socket after the request was read (ambiguous network case). */
  destroy?: boolean;
};

export type GitHubMock = {
  baseUrl: string;
  requests: MockRequest[];
  posts: () => MockRequest[];
};

export async function githubMockServer(
  t: TestContext,
  route: (request: MockRequest) => MockResponse,
): Promise<GitHubMock> {
  const requests: MockRequest[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const recorded: MockRequest = {
        method: request.method ?? "GET",
        path: request.url ?? "/",
        headers: request.headers,
        body,
      };
      requests.push(recorded);
      const result = route(recorded);
      if (result.destroy) {
        request.socket.destroy();
        return;
      }
      response.writeHead(result.status, { "content-type": "application/json", ...result.headers });
      response.end(result.body === undefined ? "" : JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    posts: () => requests.filter((request) => request.method === "POST"),
  };
}
