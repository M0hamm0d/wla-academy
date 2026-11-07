"use client";

import { useEffect } from "react";

/**
 * Temporary mission drafts live in this tab's sessionStorage only (D-99). When
 * the account they belong to is closed, or someone signs out, they're cleared
 * here rather than left until the tab closes (D-148).
 */
export function ForgetMissionDrafts() {
  useEffect(() => {
    try {
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const key = sessionStorage.key(i);
        if (key?.startsWith("wla-draft:")) sessionStorage.removeItem(key);
      }
    } catch {
      /* storage unavailable: nothing was kept */
    }
  }, []);
  return null;
}
