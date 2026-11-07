/**
 * Inline nav icons.
 *
 * Hand-drawn rather than added as a dependency: there are nine of them, they
 * are all one weight, and an icon package would bring several hundred more
 * plus a tree-shaking question. `stroke="currentColor"` so they inherit the
 * nav item's colour in every state.
 *
 * All are aria-hidden: each sits beside its own visible label, so announcing
 * them would repeat the label to a screen reader.
 */
type IconProps = { className?: string };

function Svg({ children, className }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? "size-[20px] shrink-0"}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconMissions = (p: IconProps) => (
  <Svg {...p}><path d="M3 10.5 12 4l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z" /></Svg>
);
export const IconBoard = (p: IconProps) => (
  <Svg {...p}><circle cx="9" cy="9" r="2.6" /><circle cx="16.5" cy="10.5" r="2.1" /><path d="M4 19c0-2.5 2.2-4.2 5-4.2s5 1.7 5 4.2" /><path d="M15 19c0-1.9 1.3-3.2 3-3.2s2 .6 2 .6" /></Svg>
);
export const IconAccount = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="8" r="3.4" /><path d="M5 20c0-3.6 3.1-5.6 7-5.6s7 2 7 5.6" /></Svg>
);
export const IconHelp = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M9.6 9.4a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.8-.9 1.4v.4" /><path d="M12 17h.01" /></Svg>
);
export const IconLogout = (p: IconProps) => (
  <Svg {...p}><path d="M14 20H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h8" /><path d="m17 15 3-3-3-3" /><path d="M20 12H10" /></Svg>
);
export const IconOverview = (p: IconProps) => (
  <Svg {...p}><rect x="3.5" y="3.5" width="7" height="7" rx="1.2" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.2" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.2" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.2" /></Svg>
);
export const IconBuilder = (p: IconProps) => (
  <Svg {...p}><path d="M4 7h10" /><path d="M4 12h16" /><path d="M4 17h7" /><circle cx="17.5" cy="7" r="2.2" /><circle cx="14.5" cy="17" r="2.2" /></Svg>
);
export const IconParents = (p: IconProps) => (
  <Svg {...p}><circle cx="8.5" cy="8" r="3" /><path d="M2.5 19c0-3.2 2.7-5 6-5s6 1.8 6 5" /><path d="M16 5.2a3 3 0 0 1 0 5.6" /><path d="M17.5 14.4c2.3.5 4 2.1 4 4.6" /></Svg>
);
export const IconChildren = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="7.5" r="3" /><path d="M6 20c0-3.4 2.7-5.5 6-5.5s6 2.1 6 5.5" /><path d="M9.6 6.2 8 3.6" /><path d="m14.4 6.2 1.6-2.6" /></Svg>
);
export const IconOrders = (p: IconProps) => (
  <Svg {...p}><path d="M4.5 7.5h15l-1.2 11a1 1 0 0 1-1 .9H6.7a1 1 0 0 1-1-.9Z" /><path d="M9 7.5a3 3 0 0 1 6 0" /></Svg>
);
export const IconActivity = (p: IconProps) => (
  <Svg {...p}><path d="M3 12h4l2.5-6 5 13L17 12h4" /></Svg>
);
export const IconAnalytics = (p: IconProps) => (
  <Svg {...p}><path d="M4 20V10" /><path d="M10 20V4" /><path d="M16 20v-7" /><path d="M22 20H2" /></Svg>
);
export const IconSettings = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6" /></Svg>
);
export const IconMission = (p: IconProps) => (
  <Svg {...p}><rect x="3.5" y="4.5" width="17" height="15" rx="1.6" /><path d="M3.5 9.5h17" /><path d="M8 14h8" /></Svg>
);
export const IconJournal = (p: IconProps) => (
  <Svg {...p}><path d="M12 6.5c-1.8-1.4-4.4-2-7.5-2v13c3.1 0 5.7.6 7.5 2 1.8-1.4 4.4-2 7.5-2v-13c-3.1 0-5.7.6-7.5 2Z" /><path d="M12 6.5v13" /></Svg>
);
export const IconReviews = (p: IconProps) => (
  <Svg {...p}><path d="M4 5.5h16v11H9l-5 3v-14Z" /><path d="m12 8 1 2.1 2.3.3-1.7 1.6.4 2.3-2-1.1-2 1.1.4-2.3-1.7-1.6 2.3-.3L12 8Z" /></Svg>
);
export const IconImport = (p: IconProps) => (
  <Svg {...p}><path d="M12 3.5v11" /><path d="m7.5 10 4.5 4.5 4.5-4.5" /><path d="M4.5 16.5v2a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-2" /></Svg>
);
export const IconTag = (p: IconProps) => (
  <Svg {...p}><path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1 1 0 0 1 0 1.4l-6.9 6.9a1 1 0 0 1-1.4 0Z" /><circle cx="8" cy="8" r="1.4" /></Svg>
);
export const IconPrivacy = (p: IconProps) => (
  <Svg {...p}><path d="M12 3.5 5 6.5v5c0 4.2 3 7.6 7 9 4-1.4 7-4.8 7-9v-5l-7-3Z" /><path d="M9.5 12l1.8 1.8 3.4-3.6" /></Svg>
);
