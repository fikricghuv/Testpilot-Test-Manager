"use client";

import { useEffect } from "react";
import { authMe } from "@/lib/api";
import { captureTestPilotEvent, identifyTestPilotUser, isPostHogEnabled } from "@/lib/posthog";

/**
 * After login, bind PostHog to the TestPilot user with their real email (not masked)
 * so Persons / Activity show who is using the product.
 */
export default function PostHogIdentify() {
  useEffect(() => {
    if (!isPostHogEnabled()) return;
    let cancelled = false;

    authMe().then((me) => {
      if (cancelled || !me) return;
      identifyTestPilotUser(me);
      captureTestPilotEvent("testpilot_session_started", {
        email: me.email,
        user_id: me.userId,
      });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
