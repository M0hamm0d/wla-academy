"use client";

import { useState, type InputHTMLAttributes } from "react";
import { Input } from "@/components/ui/field";
import { cn } from "@/lib/utils";

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  invalid?: boolean;
};

export function PasswordInput({
  className,
  invalid,
  ...props
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <Input
        {...props}
        type={visible ? "text" : "password"}
        invalid={invalid}
        className={cn(
          "pr-[calc(var(--space-m)+var(--target-min))]",
          className,
        )}
      />
      <button
        type="button"
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        onClick={() => setVisible((current) => !current)}
        className="absolute right-0 top-0 inline-flex min-h-[var(--target-min)] min-w-[var(--target-min)] items-center justify-center rounded-[var(--radius-control)] text-[var(--color-text-action)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]"
      >
        {visible ? (
          <svg
            viewBox="0 0 24 24"
            className="size-[20px]"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M3 3l18 18" />
            <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
            <path d="M9.9 5.2A11 11 0 0 1 12 5c5.2 0 8.5 4.3 9.5 7-.4 1.1-1.3 2.5-2.7 3.8" />
            <path d="M6.2 6.2C3.9 7.7 2.7 10 2.5 12c.5 1.4 3.8 7 9.5 7 1.1 0 2.2-.2 3.1-.6" />
          </svg>
        ) : (
          <svg
            viewBox="0 0 24 24"
            className="size-[20px]"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M2.5 12s3.3-7 9.5-7 9.5 7 9.5 7-3.3 7-9.5 7-9.5-7-9.5-7Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
}
