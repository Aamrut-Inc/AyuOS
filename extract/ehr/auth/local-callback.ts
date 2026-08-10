export interface CallbackResult {
  code: string;
  state: string;
}

export function startLocalCallbackServer(
  redirectUri: string,
  expectedState: string,
  successRedirectUrl?: string
): Promise<{
  result: Promise<CallbackResult>;
  stop: () => void;
}> {
  const callbackUrl = new URL(redirectUri);
  const port = Number(callbackUrl.port || "80");
  const path = callbackUrl.pathname;

  let resolveResult!: (result: CallbackResult) => void;
  let rejectResult!: (error: Error) => void;

  const result = new Promise<CallbackResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const server = Bun.serve({
    hostname: callbackUrl.hostname,
    port,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname !== path) {
        return new Response("Not found", { status: 404 });
      }

      const error = url.searchParams.get("error");
      if (error) {
        rejectResult(new Error(`OAuth provider returned error: ${error}`));
        return new Response("Authorization failed. You can close this tab.", {
          status: 400
        });
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      if (!code || !state) {
        rejectResult(new Error("OAuth callback missing code or state"));
        return new Response("Authorization callback was incomplete.", {
          status: 400
        });
      }

      if (state !== expectedState) {
        rejectResult(new Error("OAuth state mismatch"));
        return new Response("Authorization state did not match.", {
          status: 400
        });
      }

      resolveResult({ code, state });
      return successRedirectUrl
        ? Response.redirect(successRedirectUrl, 302)
        : new Response(
            "Authorization complete. You can close this tab and return to the terminal."
          );
    }
  });

  return Promise.resolve({
    result,
    stop: () => server.stop(true)
  });
}
