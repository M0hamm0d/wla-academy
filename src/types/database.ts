/**
 * Supabase schema types.
 *
 * Hand-written to mirror supabase/migrations/20260925220000_init.sql so the app types
 * compile before a Supabase project exists. Once one is provisioned, replace
 * this file wholesale with:
 *
 *   npx supabase gen types typescript --project-id <id> > src/types/database.ts
 *
 * Row types are declared standalone and the Database map is assembled from
 * them — a self-referential `Partial<Database[...]["Row"]>` inside the map
 * makes TypeScript resolve the whole table to `never`.
 */

export type MissionStatus = "not_started" | "in_progress" | "complete";
export type EntitlementSource =
  "free" | "purchase" | "gift" | "redeemed" | "admin";
export type EntitlementStatus = "active" | "revoked";
export type MissionDelivery = "physical" | "hybrid" | "digital";
export type WlaLab =
  "challenge" | "decision" | "curiosity" | "wellbeing" | "navigation";
export type ScreenTypeDb =
  | "content"
  | "choice"
  | "response"
  | "reveal"
  | "handoff"
  | "prepare"
  | "multi_choice"
  | "tracker"
  | "sort_items"
  | "tracker_confirmation"
  | "reflection"
  | "completion";
export type ResourceType = "pdf" | "image" | "document" | "other";
export type EvidenceType = "physical" | "digital";
export type ReviewAttribution = "anonymous" | "first_name" | "initials";
export type ReviewStatus = "pending" | "published" | "declined";

export type Json =
  string | number | boolean | null | { [k: string]: Json } | Json[];

// ------------------------------------------------------------------ rows --

export type ProfileRow = {
  id: string;
  email: string;
  name: string | null;
  /**
   * CMS-01 gate. Set by hand in the dashboard; no interface writes it, and it
   * grants catalogue editing only — never access to a family's mission data.
   */
  is_admin: boolean;
  created_at: string;
  updated_at: string;
};

export type ChildProfileRow = {
  id: string;
  parent_id: string;
  display_name: string;
  birth_year: number | null;
  /** Makes adding a child safe to retry (D-144). */
  creation_key: string | null;
  /**
   * Set once a closure covers this profile (D-148). From then on no parent
   * path returns it, though the row stays until the deletion finishes.
   */
  closing_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MissionRow = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  lab: WlaLab;
  min_age: number;
  max_age: number;
  duration: string | null;
  delivery_type: MissionDelivery;
  cover_image: string | null;
  /** Minor units (e.g. pence). Paired with `currency` — never assumed. */
  price_minor: number | null;
  currency: string;
  /** Tech Spec §31 — completion is configured, never hard-coded per mission. */
  completion_rule: Json | null;
  is_free: boolean;
  version: number;
  published: boolean;
  created_at: string;
  updated_at: string;
};

export type GiftStatus = "pending" | "paid" | "redeemed";

/** D-140. Service role only: no client role can read this table. */
export type MissionGiftRow = {
  id: string;
  mission_id: string;
  purchaser_id: string | null;
  /** Null only while the Stripe session is being created. */
  stripe_session_id: string | null;
  attempt_key: string | null;
  checkout_status: "initializing" | "open" | "paid" | "expired" | "failed";
  mission_title: string | null;
  mission_description: string | null;
  mission_slug: string | null;
  /** The purchaser's own address, for Stripe. Removed when the account closes (D-148). */
  customer_email: string | null;
  site_origin: string | null;
  stripe_payment_intent_id: string | null;
  amount_minor: number;
  currency: string;
  status: GiftStatus;
  claim_hash: string | null;
  claim_expires_at: string | null;
  /** HMAC of the code (D-149). Never the code itself. */
  code_lookup: string | null;
  /** The purchaser's AES-GCM copy, opened only on the server. */
  code_ciphertext: string | null;
  code_issued_at: string | null;
  early_supply_consent_at: string | null;
  cancellation_ack_at: string | null;
  consent_wording: string | null;
  confirmation_sent_at: string | null;
  paid_at: string | null;
  redeemed_at: string | null;
  redeemed_by: string | null;
  redeemed_child_id: string | null;
  created_at: string;
};

export type MissionScreenRow = {
  id: string;
  mission_id: string;
  screen_key: string;
  type: ScreenTypeDb;
  title: string | null;
  body: string | null;
  sequence: number;
  configuration: Json;
  /** D-17 — screens are versioned; a learner is served their pinned version. */
  version: number;
  created_at: string;
  updated_at: string;
};

export type MissionResourceRow = {
  version: number;
  id: string;
  mission_id: string;
  title: string;
  description: string | null;
  type: ResourceType;
  storage_path: string;
  can_view: boolean;
  can_print: boolean;
  can_download: boolean;
  sort_order: number;
  created_at: string;
};

/** F7 — media a screen shows, pinned to its version (0032). Never read by a client role. */
/** Mission Board (0036): no author, no counts — by construction. */
export type BoardStatus = "pending_permission" | "pending_moderation" | "published" | "rejected";
export type BoardRejectedReason = "cannot_anonymise" | "not_suitable";
/** What the anonymity check found worth a second look (D-151). Never proof of anonymity. */
export type BoardFlag = "names" | "contact" | "school" | "location" | "age" | "possible_full_name";
export type BoardModerationAction = "publish" | "reject" | "keep_private" | "unpublish" | "save" | "remove";

/** Account closure and retention (D-148). */
export type PrivacySubject = "parent_account" | "child_profile";
export type PrivacyDeletionStatus = "in_progress" | "held" | "failed" | "completed";
export type HoldSubject = PrivacySubject | "board_contribution" | "security_logs";
export type BoardItem = { mission_slug: string; mission_title: string; lab: WlaLab; text: string; approach: string | null; curated: boolean; published_at: string };

export type MissionAssetKind = "image" | "diagram" | "map" | "animation" | "audio" | "video";
export type MissionAssetRow = {
  id: string;
  mission_id: string;
  version: number;
  key: string;
  kind: MissionAssetKind;
  storage_path: string;
  alt_text: string | null;
  long_description: string | null;
  transcript: string | null;
  captions_path: string | null;
  created_at: string;
};

export type MissionParentNoteRow = {
  version: number;
  id: string;
  mission_id: string;
  content: string;
  /**
   * Optional print-ready note in the private bucket, under the mission id.
   * Served only as a short-lived signed URL. NULL = text only.
   */
  document_path: string | null;
  updated_at: string;
};

export type MissionEntitlementRow = {
  id: string;
  child_id: string;
  mission_id: string;
  source: EntitlementSource;
  status: EntitlementStatus;
  stripe_payment_intent_id: string | null;
  granted_at: string;
  created_at: string;
};

export type MissionProgressRow = {
  id: string;
  child_id: string;
  mission_id: string;
  status: MissionStatus;
  current_screen_key: string | null;
  /** D-17 — pinned at first start, never re-pinned. */
  mission_version: number;
  /** D-17 — completion semantics as they stood when this run began. */
  completion_rule: Json | null;
  started_at: string | null;
  completed_at: string | null;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
  /** D-76 — random per-run key for analytics sequencing. Never a child id. */
  analytics_key?: string;
};

export type MissionStateRow = {
  progress_id: string;
  state_data: Json;
  updated_at: string;
};

export type MissionResponseRow = {
  id: string;
  progress_id: string;
  screen_key: string;
  value: Json;
  created_at: string;
  updated_at: string;
};

export type StripeEventRow = {
  id: string;
  type: string;
  processed_at: string;
};

/** Shared public-site review table; its schema is provisioned in the shared Supabase project. */
export type ReviewRow = {
  id: string;
  rating: number;
  body: string;
  mission_slug: string | null;
  mission_name: string | null;
  reviewer_name: string | null;
  reviewer_email: string | null;
  attribution: ReviewAttribution;
  display_name: string;
  consent: boolean;
  status: ReviewStatus;
  verified: boolean;
  featured: boolean;
  featured_order: number;
  admin_notes: string | null;
  published_at: string | null;
  submitted_at: string;
  created_at: string;
  updated_at: string;
};

export type CheckoutIntentRow = {
  id: string;
  /** Null only while the Stripe session is being created. */
  stripe_session_id: string | null;
  attempt_key: string | null;
  checkout_status: "initializing" | "open" | "paid" | "expired" | "failed";
  mission_title: string | null;
  mission_description: string | null;
  mission_slug: string | null;
  /** The purchaser's own address, for Stripe. Removed when the account closes (D-148). */
  customer_email: string | null;
  site_origin: string | null;
  /** Null once the account closed: the paid record stays, without the family (D-148). */
  parent_id: string | null;
  child_id: string | null;
  mission_id: string;
  amount_minor: number;
  currency: string;
  created_at: string;
  paid_at: string | null;
  stripe_payment_intent_id: string | null;
  early_supply_consent_at: string | null;
  cancellation_ack_at: string | null;
  consent_wording: string | null;
  confirmation_sent_at: string | null;
};

export type MissionEvidenceRow = {
  id: string;
  child_id: string;
  mission_id: string;
  progress_id: string | null;
  type: EvidenceType;
  title: string;
  description: string | null;
  /** NULL for physical evidence — the Academy does not hold the artefact. */
  storage_path: string | null;
  created_at: string;
  /** Evidence v2 (F6). */
  evidence_key?: string | null;
  screen_key?: string | null;
  related_to?: string | null;
  relation?: "revision_of" | "changed_plan_of" | "result_of" | "later_judgement_of" | "after_of" | null;
  source?: "completion" | "mission";
};

// ------------------------------------------------- LMS additions (D-56–D-60) --

export type MissionVersionStatus =
  | "draft"
  | "in_review"
  | "published"
  | "archived";

export type MissionVersionRow = {
  id: string;
  mission_id: string;
  version: number;
  status: MissionVersionStatus;
  completion_rule: Json | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  published_at: string | null;
  archived_at: string | null;
};

/**
 * What a PARENT may read about a child's access code.
 *
 * `code_hash` and `code_lookup` are deliberately absent from this type as well
 * as from the column grants — the shape of the type and the shape of the grant
 * agree, so a query for a withheld column fails to compile rather than at
 * runtime.
 */
export type ChildAccessCredentialRow = {
  id: string;
  child_id: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  /** Whether "Show access code" can work. The ciphertext itself is never readable by a client. */
  has_viewable_copy: boolean;
  code_last_viewed_at: string | null;
};

export type ChildSessionRow = {
  id: string;
  child_id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
};

// ---------------------------------------------------------------- journal --
// Journal CMS (D-123 … D-129, migration 20261014120000_journal_cms.sql).
// Staff read these through RLS; NOTHING is written directly — every change is
// a journal_* function. Public pages never read these tables at all.

export type JournalRole = "writer" | "reviewer" | "editor";
export type JournalRevisionState =
  | "draft"
  | "in_review"
  | "changes_requested"
  | "approved"
  | "live"
  | "retired"
  | "superseded";
export type JournalDecision = "approve" | "request_changes";

export type JournalCategoryRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  sort_order: number;
  created_at: string;
};

export type JournalArticleRow = {
  id: string;
  live_revision_id: string | null;
  working_revision_id: string | null;
  slug: string | null;
  published_at: string | null;
  first_published_at: string | null;
  archived_at: string | null;
  scheduled_revision_id: string | null;
  scheduled_for: string | null;
  scheduled_by: string | null;
  scheduled_hash: string | null;
  schedule_attempts: number;
  previous_slugs: string[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type JournalRevisionRow = {
  id: string;
  article_id: string;
  number: number;
  state: JournalRevisionState;
  based_on: string | null;
  title: string;
  slug: string;
  excerpt: string | null;
  body_html: string;
  author_name: string | null;
  author_profile_id: string | null;
  category_id: string | null;
  tags: string[];
  featured_media_id: string | null;
  featured_alt: string | null;
  seo_title: string | null;
  seo_description: string | null;
  canonical_url: string | null;
  original_published_at: string | null;
  source_url: string | null;
  content_hash: string;
  lock_version: number;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  submitted_by: string | null;
  submitted_at: string | null;
  decided_at: string | null;
};

export type JournalMediaRow = {
  id: string;
  article_id: string;
  storage_path: string;
  mime_type: string;
  bytes: number;
  alt_text: string | null;
  source_url: string | null;
  is_public: boolean;
  uploaded_by: string | null;
  created_at: string;
};

/** D-134: a view-only preview link. The token is never stored, only its SHA-256. */
export type JournalPreviewLinkRow = {
  id: string;
  article_id: string;
  token_hash: string;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
};

/** What a preview link shows (journal_preview_article): the latest saved version only. */
export type JournalPreviewArticleRow = {
  title: string;
  excerpt: string | null;
  body_html: string;
  author_name: string | null;
  category_name: string | null;
  tags: string[];
  featured_media_id: string | null;
  featured_alt: string | null;
  original_published_at: string | null;
  first_published_at: string | null;
  source_url: string | null;
  saved_at: string;
  is_live: boolean;
};

export type JournalMemberRow = {
  article_id: string;
  profile_id: string;
  role: "author" | "collaborator";
  added_by: string | null;
  added_at: string;
};

export type JournalAssignmentRow = {
  article_id: string;
  reviewer_id: string;
  assigned_by: string | null;
  assigned_at: string;
};

export type JournalDecisionRow = {
  id: string;
  article_id: string;
  revision_id: string;
  reviewer_id: string | null;
  decision: JournalDecision;
  content_hash: string;
  note: string | null;
  decided_at: string;
};

export type JournalCommentRow = {
  id: string;
  article_id: string;
  revision_id: string | null;
  parent_id: string | null;
  author_id: string | null;
  body: string;
  anchor: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
};

export type JournalChangeRow = {
  id: number;
  revision_id: string;
  actor_id: string | null;
  changed_fields: string[];
  lock_version: number;
  content_hash: string;
  at: string;
};

export type JournalAuditRow = {
  id: number;
  article_id: string | null;
  revision_id: string | null;
  actor_id: string | null;
  action: string;
  detail: Json;
  at: string;
};

export type JournalStaffRow = {
  profile_id: string;
  role: JournalRole;
  granted_by: string | null;
  created_at: string;
};

export type JournalImportRunRow = {
  id: string;
  source_kind: string;
  source_name: string | null;
  started_by: string | null;
  started_at: string;
  finished_at: string | null;
  totals: Json;
};

export type JournalImportItemRow = {
  id: number;
  run_id: string;
  source_id: string | null;
  source_url: string | null;
  title: string | null;
  outcome: string;
  article_id: string | null;
  final_slug: string | null;
  messages: Json;
  created_at: string;
};

/** What the public functions return — live revision fields only (D-127). */
export type JournalPublicListRow = {
  slug: string;
  title: string;
  excerpt: string | null;
  author_name: string | null;
  category_slug: string | null;
  category_name: string | null;
  tags: string[];
  featured_media_id: string | null;
  featured_alt: string | null;
  display_date: string | null;
  updated_at: string | null;
  word_count: number;
};

export type JournalPublicArticleRow = {
  slug: string | null;
  title: string | null;
  excerpt: string | null;
  body_html: string | null;
  author_name: string | null;
  category_slug: string | null;
  category_name: string | null;
  tags: string[] | null;
  featured_media_id: string | null;
  featured_alt: string | null;
  seo_title: string | null;
  seo_description: string | null;
  canonical_url: string | null;
  source_url: string | null;
  display_date: string | null;
  first_published_at: string | null;
  updated_at: string | null;
  redirect_to: string | null;
};

// -------------------------------------------------------------- database --

/** Generated columns a caller never supplies. */
type Generated = "id" | "created_at" | "updated_at";

type Table<Row, Required extends keyof Row, Extra extends keyof Row = never> = {
  Row: Row;
  Insert: Pick<Row, Required> &
    Partial<Omit<Row, Required | Generated | Extra>>;
  Update: Partial<Omit<Row, Generated>>;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: ProfileRow;
        Insert: Pick<ProfileRow, "id" | "email"> &
          Partial<Pick<ProfileRow, "name">>;
        // `is_admin` is deliberately absent: it is not an editable field.
        Update: Partial<Pick<ProfileRow, "email" | "name">>;
        Relationships: [];
      };
      reviews: Table<ReviewRow, "body" | "rating">;
      child_profiles: Table<ChildProfileRow, "parent_id" | "display_name">;
      missions: Table<
        MissionRow,
        "slug" | "title" | "lab" | "min_age" | "max_age"
      >;
      mission_screens: Table<
        MissionScreenRow,
        "mission_id" | "screen_key" | "type" | "sequence"
      >;
      mission_resources: Table<
        MissionResourceRow,
        "mission_id" | "title" | "storage_path"
      >;
      mission_assets: Table<
        MissionAssetRow,
        "mission_id" | "version" | "key" | "kind" | "storage_path"
      >;
      mission_parent_notes: Table<
        MissionParentNoteRow,
        "mission_id" | "content"
      >;
      mission_entitlements: Table<
        MissionEntitlementRow,
        "child_id" | "mission_id" | "source"
      >;
      mission_progress: Table<MissionProgressRow, "child_id" | "mission_id">;
      mission_state: Table<MissionStateRow, "progress_id">;
      mission_responses: Table<
        MissionResponseRow,
        "progress_id" | "screen_key" | "value"
      >;
      mission_evidence: Table<
        MissionEvidenceRow,
        "child_id" | "mission_id" | "type" | "title"
      >;
      stripe_events: {
        Row: StripeEventRow;
        Insert: Pick<StripeEventRow, "id" | "type">;
        Update: Partial<StripeEventRow>;
        Relationships: [];
      };
      mission_gifts: Table<
        MissionGiftRow,
        | "mission_id"
        | "amount_minor"
        | "currency"
        | "early_supply_consent_at"
        | "cancellation_ack_at"
        | "consent_wording"
      >;
      checkout_intents: Table<
        CheckoutIntentRow,
        | "parent_id"
        | "child_id"
        | "mission_id"
        | "amount_minor"
        | "currency"
        | "early_supply_consent_at"
        | "cancellation_ack_at"
        | "consent_wording"
      >;
      mission_versions: {
        Row: MissionVersionRow;
        Insert: Pick<MissionVersionRow, "mission_id" | "version"> &
          Partial<Pick<MissionVersionRow, "status" | "completion_rule" | "notes">>;
        // Status moves through set_mission_version_status, never a direct write.
        Update: Partial<Pick<MissionVersionRow, "notes">>;
        Relationships: [];
      };
      child_access_credentials: {
        Row: ChildAccessCredentialRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      child_sessions: {
        Row: ChildSessionRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      journal_categories: Table<JournalCategoryRow, "slug" | "name">;
      journal_articles: {
        Row: JournalArticleRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      journal_revisions: {
        Row: JournalRevisionRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      journal_media: {
        Row: JournalMediaRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      journal_article_members: {
        Row: JournalMemberRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      journal_review_assignments: {
        Row: JournalAssignmentRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      journal_review_decisions: {
        Row: JournalDecisionRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      journal_comments: {
        Row: JournalCommentRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      journal_revision_changes: {
        Row: JournalChangeRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      journal_audit: {
        Row: JournalAuditRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      journal_preview_links: {
        Row: JournalPreviewLinkRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      journal_staff: {
        Row: JournalStaffRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      journal_import_runs: {
        Row: JournalImportRunRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      journal_import_items: {
        Row: JournalImportItemRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    /**
     * Atomic persistence operations (the persistence migration). Each is one
     * transaction — see supabase/migrations/20260925220200_persistence.sql.
     */
    Functions: {
      // ------------------------------------------------ journal (D-123…) --
      journal_staff_directory: {
        Args: Record<string, never>;
        Returns: { profile_id: string; name: string | null; email: string; roles: JournalRole[]; is_admin: boolean }[];
      };
      journal_set_role: {
        Args: { p_email: string; p_role: JournalRole; p_grant: boolean };
        Returns: string;
      };
      journal_create_article: { Args: { p_title: string; p_slug: string }; Returns: string };
      journal_save_revision: {
        Args: { p_revision: string; p_expected_lock: number; p_fields: Json };
        Returns: { outcome: "saved" | "unchanged" | "conflict"; lock_version: number; content_hash: string; updated_by: string | null; updated_at: string }[];
      };
      journal_start_revision: { Args: { p_article: string }; Returns: string };
      journal_submit_for_review: { Args: { p_revision: string; p_expected_lock: number }; Returns: undefined };
      journal_withdraw_submission: { Args: { p_revision: string }; Returns: undefined };
      journal_assign_reviewer: { Args: { p_article: string; p_reviewer: string; p_assign: boolean }; Returns: undefined };
      journal_decide: {
        Args: { p_revision: string; p_decision: JournalDecision; p_expected_hash: string; p_note: string | null };
        Returns: undefined;
      };
      journal_add_comment: {
        Args: { p_article: string; p_revision: string | null; p_body: string; p_parent: string | null; p_anchor: string | null };
        Returns: string;
      };
      journal_resolve_comment: { Args: { p_comment: string; p_resolved: boolean }; Returns: undefined };
      journal_set_member: { Args: { p_article: string; p_profile: string; p_role: "author" | "collaborator" | null }; Returns: undefined };
      journal_publish: { Args: { p_revision: string; p_expected_hash: string }; Returns: undefined };
      journal_schedule: { Args: { p_revision: string; p_expected_hash: string; p_at: string }; Returns: undefined };
      journal_cancel_schedule: { Args: { p_article: string }; Returns: undefined };
      journal_scheduler_status: {
        Args: Record<string, never>;
        Returns: { configured: boolean; active: boolean; last_run_at: string | null; last_status: string | null; overdue: number }[];
      };
      journal_unpublish: { Args: { p_article: string }; Returns: undefined };
      journal_archive: { Args: { p_article: string; p_archive: boolean }; Returns: undefined };
      journal_delete_article: { Args: { p_article: string }; Returns: undefined };
      journal_register_media: {
        Args: { p_article: string; p_path: string; p_mime: string; p_bytes: number; p_alt: string | null; p_source_url: string | null };
        Returns: string;
      };
      journal_public_list: {
        Args: { p_category?: string | null; p_tag?: string | null; p_query?: string | null; p_limit?: number; p_offset?: number };
        Returns: JournalPublicListRow[];
      };
      journal_public_article: { Args: { p_slug: string }; Returns: JournalPublicArticleRow[] };
      journal_public_tags: { Args: Record<string, never>; Returns: { tag: string }[] };
      journal_media_path: { Args: { p_id: string }; Returns: string | null };
      journal_create_preview_link: { Args: { p_article: string; p_days?: number }; Returns: { link_id: string; token: string; expires_at: string }[] };
      journal_revoke_preview_link: { Args: { p_link: string }; Returns: undefined };
      journal_preview_article: { Args: { p_token: string }; Returns: JournalPreviewArticleRow[] };
      journal_preview_media_path: { Args: { p_token: string; p_media: string }; Returns: string | null };
      journal_unused_media: { Args: { p_article: string }; Returns: { media_id: string | null; storage_path: string }[] };
      journal_forget_media: { Args: { p_media: string }; Returns: string };
      journal_media_removable: { Args: { p_name: string }; Returns: boolean };
      journal_import_start: { Args: { p_kind: string; p_name: string }; Returns: string };
      journal_import_log: {
        Args: {
          p_run: string; p_source_id: string; p_source_url: string | null; p_title: string;
          p_outcome: string; p_article: string | null; p_slug: string | null; p_messages: Json;
        };
        Returns: undefined;
      };
      journal_import_finish: { Args: { p_run: string; p_totals: Json }; Returns: undefined };
      journal_import_prepare: {
        Args: { p_kind: string; p_source_id: string; p_source_hash: string; p_title: string };
        Returns: { outcome: "new" | "unchanged" | "update" | "edited"; article_id: string; revision_id: string }[];
      };
      journal_import_apply: {
        Args: { p_article: string; p_kind: string; p_source_id: string; p_source_hash: string; p_source_url: string | null; p_fields: Json };
        Returns: { final_slug: string; slug_changed: boolean }[];
      };
      start_mission: {
        Args: { p_child_id: string; p_mission_id: string };
        Returns: MissionProgressRow;
      };
      /** D-80 — service role only. The caller has authorised the run. */
      engine_load_run: {
        Args: { p_progress_id: string };
        Returns: Json;
      };
      engine_save: {
        Args: {
          p_progress_id: string;
          p_state: Json;
          p_private: Json;
          p_screen_key: string | null;
          p_response_key: string | null;
          p_response_value: Json;
          p_complete: boolean;
          p_evidence: Json;
          p_events: Json;
        };
        Returns: MissionProgressRow;
      };
      engine_record_events: {
        Args: { p_progress_id: string; p_events: Json };
        Returns: undefined;
      };
      admin_duplicate_mission: {
        Args: { p_source_id: string; p_slug: string; p_title: string; p_from_version?: number | null };
        Returns: Json;
      };
      admin_mission_insights: {
        Args: { p_mission_id: string; p_version?: number | null };
        Returns: Json;
      };
      admin_upsert_asset: {
        Args: {
          p_mission_id: string; p_version: number; p_key: string; p_kind: string; p_storage_path: string;
          p_alt_text: string | null; p_long_description: string | null; p_transcript: string | null; p_captions_path: string | null;
        };
        Returns: MissionAssetRow;
      };
      admin_delete_asset: {
        Args: { p_mission_id: string; p_version: number; p_key: string };
        Returns: undefined;
      };
      admin_draft_assets: {
        Args: { p_mission_id: string; p_version: number };
        Returns: MissionAssetRow[];
      };
      // Mission Board (0036)
      board_offer: { Args: { p_child_id: string; p_evidence_id: string }; Returns: string };
      child_session_board_offer: { Args: { p_token: string; p_evidence_id: string }; Returns: string | null };
      board_family_contributions: {
        Args: Record<string, never>;
        Returns: {
          id: string; child_id: string; child_name: string; mission_title: string; text: string;
          status: BoardStatus; created_at: string; evidence_id: string;
          rejected_reason: BoardRejectedReason | null; delete_after: string | null;
        }[];
      };
      child_session_board_offers: { Args: { p_token: string }; Returns: { evidence_id: string; status: BoardStatus }[] };
      board_permit: { Args: { p_id: string; p_allow: boolean }; Returns: undefined };
      board_withdraw: { Args: { p_id: string }; Returns: undefined };
      board_published: { Args: { p_child_id: string }; Returns: BoardItem[] };
      child_session_board: { Args: { p_token: string }; Returns: BoardItem[] };
      admin_board_queue: {
        Args: Record<string, never>;
        Returns: {
          id: string; mission_title: string; lab: WlaLab; text: string; status: BoardStatus; curated: boolean;
          approach: string | null; created_at: string; moderated_at: string | null; flags: BoardFlag[];
        }[];
      };
      admin_board_moderate: {
        Args: {
          p_id: string; p_action: BoardModerationAction; p_text: string | null; p_curated: boolean | null;
          p_approach: string | null; p_anonymity_confirmed?: boolean;
        };
        Returns: undefined;
      };
      admin_draft_definition: {
        Args: { p_mission_id: string; p_version: number };
        Returns: Json;
      };
      admin_set_definition: {
        Args: { p_mission_id: string; p_version: number; p_definition: Json };
        Returns: undefined;
      };
      persist_mission_state: {
        Args: {
          p_progress_id: string;
          p_state: Json;
          p_screen_key?: string | null;
          p_response_key?: string | null;
          p_response_value?: Json;
        };
        Returns: MissionProgressRow;
      };
      complete_mission: {
        Args: { p_progress_id: string; p_state: Json; p_trail?: Json };
        Returns: MissionProgressRow;
      };
      /**
       * The ONLY path to screen content. mission_screens has no client read
       * policy — see the screen_access migration.
       */
      /** ANALYTICS-01. Child id is an authorisation input, never stored. */
      record_mission_event: {
        Args: { p_child_id: string; p_mission_id: string; p_name: string };
        Returns: undefined;
      };
      /** CMS-01 admin dashboard. Refuses unless `is_admin()`. */
      admin_mission_stats: {
        Args: { p_stale_days?: number };
        Returns: {
          mission_id: string;
          slug: string;
          title: string;
          version: number;
          published: boolean;
          price_minor: number | null;
          currency: string;
          is_free: boolean;
          entitlements: number;
          starts: number;
          completions: number;
          in_progress: number;
          dropped_off: number;
        }[];
      };
      /** D-17 made visible in the editor. Refuses unless `is_admin()`. */
      admin_mission_version_usage: {
        Args: { p_mission_id: string };
        Returns: { version: number; runs: number; complete: number }[];
      };
      get_current_mission_screen: {
        Args: { p_child_id: string; p_mission_id: string };
        Returns: {
          screen_key: string;
          type: ScreenTypeDb;
          title: string | null;
          body: string | null;
          sequence: number;
          configuration: Json;
          next_sequence_key: string | null;
        }[];
      };

      // --- mission versioning (D-57) ---
      create_mission_version: {
        Args: { p_mission_id: string; p_from_version?: number | null };
        Returns: MissionVersionRow;
      };
      set_mission_version_status: {
        Args: {
          p_mission_id: string;
          p_version: number;
          p_status: MissionVersionStatus;
        };
        Returns: MissionVersionRow;
      };
      validate_mission_version: {
        Args: { p_mission_id: string; p_version: number };
        Returns: {
          code: string;
          blocking: boolean;
          screen_key: string | null;
          detail: string;
        }[];
      };
      admin_draft_screens: {
        Args: { p_mission_id: string; p_version: number };
        Returns: {
          id: string;
          screen_key: string;
          type: ScreenTypeDb;
          title: string | null;
          body: string | null;
          sequence: number;
          configuration: Json;
        }[];
      };
      admin_mission_versions: {
        Args: { p_mission_id: string };
        Returns: {
          version: number;
          status: MissionVersionStatus;
          completion_rule: Json | null;
          screens: number;
          runs: number;
          complete: number;
          created_at: string;
          published_at: string | null;
        }[];
      };

      // --- admin LMS surfaces (brief §18–§23) ---
      admin_overview: {
        Args: Record<string, never>;
        Returns: {
          parents: number; children: number; active_learners: number;
          starts: number; completions: number; published_missions: number;
          draft_missions: number; orders: number;
        }[];
      };
      admin_activity: {
        Args: { p_limit?: number };
        Returns: {
          kind: string; happened_at: string;
          subject: string | null; detail: string | null;
        }[];
      };
      admin_parents: {
        Args: { p_search?: string | null; p_limit?: number };
        Returns: {
          id: string; email: string; name: string | null; is_admin: boolean;
          joined_at: string; children: number; entitlements: number; orders: number;
        }[];
      };
      admin_children: {
        Args: { p_search?: string | null; p_limit?: number };
        Returns: {
          id: string; display_name: string; birth_year: number | null;
          parent_email: string; missions: number; in_progress: number;
          complete: number; last_activity_at: string | null;
          access_code_status: string; code_last_used_at: string | null;
        }[];
      };
      activate_paid_gift: {
        Args: { p_session_id: string; p_payment_intent: string | null };
        Returns: { outcome: "activated" | "already" | "not_found"; gift_id: string | null; code: string | null }[];
      };
      store_gift_code_copy: {
        Args: { p_gift_id: string; p_code: string; p_ciphertext: string };
        Returns: boolean;
      };
      reissue_gift_code: { Args: { p_gift_id: string; p_purchaser_id: string }; Returns: string | null };
      purchaser_gifts: {
        Args: { p_purchaser_id: string };
        Returns: {
          id: string; mission_title: string; mission_slug: string; status: GiftStatus;
          created_at: string; paid_at: string | null; redeemed_at: string | null;
          code_issued_at: string | null; code_ciphertext: string | null;
        }[];
      };
      confirm_gift_code: {
        Args: { p_code: string; p_client: string; p_claim_hash: string };
        Returns: "matched" | "invalid" | "rate_limited";
      };
      privacy_begin_closure: {
        Args: { p_subject_type: PrivacySubject; p_subject_id: string; p_parent_id: string; p_requested_by: "parent" | "admin" };
        Returns: { outcome: "begun" | "not_found" | "admin_account" | "invalid"; deletion_id: string | null; status: PrivacyDeletionStatus | null }[];
      };
      privacy_pending_files: { Args: { p_deletion: string }; Returns: { bucket: string; path: string }[] };
      privacy_record_files: {
        Args: { p_deletion: string; p_bucket: string; p_removed: string[]; p_failed: string[]; p_error: string | null };
        Returns: undefined;
      };
      privacy_finish_closure: {
        Args: { p_deletion: string };
        Returns: "files_pending" | "held" | "data_deleted" | "completed" | "not_found";
      };
      privacy_complete_closure: { Args: { p_deletion: string }; Returns: "completed" | "not_ready" | "not_found" };
      privacy_record_failure: { Args: { p_deletion: string; p_step: string; p_error: string }; Returns: undefined };
      privacy_open_deletions: {
        Args: Record<string, never>;
        Returns: { id: string; subject_type: PrivacySubject; parent_id: string; step: string }[];
      };
      privacy_orphan_files: { Args: { p_limit?: number }; Returns: { bucket: string; path: string }[] };
      privacy_retention_run: { Args: Record<string, never>; Returns: Json };
      admin_privacy_deletions: {
        Args: Record<string, never>;
        Returns: {
          id: string; subject_type: PrivacySubject; requested_by: "parent" | "admin"; requested_at: string;
          due_by: string; status: PrivacyDeletionStatus; step: string; attempts: number;
          last_error: string | null; completed_at: string | null; overdue: boolean;
          files_pending: number; children: number; summary: Json;
        }[];
      };
      admin_retention_holds: {
        Args: Record<string, never>;
        Returns: { id: string; subject_type: HoldSubject; subject_id: string | null; reason: string; placed_at: string; review_by: string; review_due: boolean }[];
      };
      admin_place_hold: {
        Args: { p_subject_type: HoldSubject; p_subject_id: string | null; p_reason: string; p_review_by: string | null };
        Returns: string;
      };
      admin_review_hold: { Args: { p_id: string; p_release: boolean; p_review_by: string | null }; Returns: undefined };
      admin_retention_runs: { Args: { p_limit?: number }; Returns: { ran_at: string; results: Json; error: string | null }[] };
      // The deletion ledger outside the database (D-157).
      privacy_ledger_pending: {
        Args: { p_limit?: number };
        Returns: { seq: number; event_id: string; event: string; payload: Json; created_at: string }[];
      };
      privacy_ledger_mark_shipped: {
        Args: { p_event_ids: string[]; p_ledger_seq: number; p_chain: string };
        Returns: undefined;
      };
      privacy_ledger_request_shipped: { Args: { p_deletion: string }; Returns: boolean };
      admin_privacy_ledger_status: {
        Args: Record<string, never>;
        Returns: { unshipped: number; oldest_unshipped: string | null; last_shipped: string | null; ledger_seq: number | null }[];
      };
      redeem_mission_gift: {
        Args: { p_claim_hash: string; p_child_id: string; p_parent_id: string };
        Returns: string;
      };
      admin_gifts: {
        Args: { p_limit?: number };
        Returns: {
          id: string; created_at: string; mission_title: string;
          purchaser_email: string | null;
          amount_minor: number; currency: string; status: GiftStatus;
          paid_at: string | null; redeemed_at: string | null;
          redeemed_by_email: string | null; redeemed_child_name: string | null;
          consent_recorded: boolean; confirmation_sent: boolean;
        }[];
      };
      admin_orders: {
        Args: { p_limit?: number };
        Returns: {
          id: string; created_at: string; parent_email: string | null;
          child_name: string | null; mission_title: string;
          amount_minor: number; currency: string; state: string;
          consent_recorded: boolean; confirmation_sent: boolean;
        }[];
      };
      admin_analytics: {
        Args: Record<string, never>;
        Returns: {
          mission_id: string; slug: string; title: string;
          published_version: number | null; entitlements: number;
          starts: number; completions: number; in_progress: number;
          quiet_14d: number; completion_rate: number;
        }[];
      };
      create_mission: {
        Args: {
          p_slug: string; p_title: string; p_lab: WlaLab;
          p_min_age: number; p_max_age: number;
        };
        Returns: MissionRow;
      };
      delete_mission_if_unused: {
        Args: { p_mission_id: string };
        Returns: boolean;
      };

      // --- mission authoring (D-56) ---
      admin_upsert_screen: {
        Args: {
          p_mission_id: string; p_version: number; p_screen_key: string;
          p_type: ScreenTypeDb; p_title: string | null; p_body: string | null;
          p_sequence: number; p_configuration: Json;
        };
        Returns: MissionScreenRow;
      };
      admin_delete_screen: {
        Args: { p_mission_id: string; p_version: number; p_screen_key: string };
        Returns: undefined;
      };
      admin_move_screen: {
        Args: {
          p_mission_id: string; p_version: number;
          p_screen_key: string; p_direction: "up" | "down";
        };
        Returns: undefined;
      };
      admin_set_completion_rule: {
        Args: { p_mission_id: string; p_version: number; p_rule: Json };
        Returns: undefined;
      };
      admin_preview_screen: {
        Args: { p_mission_id: string; p_version: number; p_screen_key?: string | null };
        Returns: {
          screen_key: string; type: ScreenTypeDb; title: string | null;
          body: string | null; sequence: number; configuration: Json;
          next_sequence_key: string | null;
        }[];
      };

      // --- Kit and Parent Note authoring (D-63) ---
      admin_draft_resources: {
        Args: { p_mission_id: string; p_version: number };
        Returns: {
          id: string; title: string; description: string | null;
          type: ResourceType; storage_path: string; can_view: boolean;
          can_print: boolean; can_download: boolean; sort_order: number;
        }[];
      };
      admin_upsert_resource: {
        Args: {
          p_mission_id: string; p_version: number; p_id: string | null;
          p_title: string; p_description: string | null; p_type: ResourceType;
          p_storage_path: string; p_can_view: boolean; p_can_print: boolean;
          p_can_download: boolean; p_sort_order: number;
        };
        Returns: MissionResourceRow;
      };
      admin_delete_resource: {
        Args: { p_mission_id: string; p_version: number; p_id: string };
        Returns: undefined;
      };
      admin_move_resource: {
        Args: {
          p_mission_id: string; p_version: number;
          p_id: string; p_direction: "up" | "down";
        };
        Returns: undefined;
      };
      admin_draft_parent_note: {
        Args: { p_mission_id: string; p_version: number };
        Returns: { content: string; document_path: string | null }[];
      };
      admin_save_parent_note: {
        Args: {
          p_mission_id: string; p_version: number;
          p_content: string; p_document_path: string | null;
        };
        Returns: undefined;
      };
      effective_mission_version: {
        Args: { p_child_id: string; p_mission_id: string };
        Returns: number;
      };
      mission_kit_for_child: {
        Args: { p_child_id: string; p_mission_id: string };
        Returns: {
          id: string; title: string; description: string | null;
          type: ResourceType; storage_path: string; can_view: boolean;
          can_print: boolean; can_download: boolean; sort_order: number;
        }[];
      };
      child_session_kit: {
        Args: { p_token: string; p_mission_slug: string };
        Returns: {
          id: string; title: string; description: string | null;
          type: ResourceType; storage_path: string; can_view: boolean;
          can_print: boolean; can_download: boolean; sort_order: number;
        }[];
      };
      child_session_resource_path: {
        Args: { p_token: string; p_resource_id: string };
        Returns: string | null;
      };

      // --- child access (D-58) ---
      generate_child_access_code: { Args: { p_child_id: string }; Returns: string };
      issue_child_access_code: {
        Args: { p_child_id: string };
        Returns: { credential_id: string; code: string }[];
      };
      store_child_code_copy: {
        Args: { p_credential_id: string; p_child_id: string; p_parent_id: string; p_ciphertext: string };
        Returns: boolean;
      };
      read_child_code_copy: {
        Args: { p_child_id: string; p_parent_id: string };
        Returns: { credential_id: string; ciphertext: string }[];
      };
      revoke_child_access_code: { Args: { p_child_id: string }; Returns: undefined };
      redeem_child_code: {
        Args: { p_code: string };
        Returns: {
          outcome: "ok" | "invalid_code" | "rate_limited";
          token: string | null;
          child_id: string | null;
          display_name: string | null;
          expires_at: string | null;
        }[];
      };
      verify_child_session: {
        Args: { p_token: string };
        Returns: {
          child_id: string;
          display_name: string;
          birth_year: number | null;
          expires_at: string;
        }[];
      };
      revoke_child_session: { Args: { p_token: string }; Returns: undefined };

      // --- child-session mission access (D-59) ---
      child_session_missions: {
        Args: { p_token: string };
        Returns: {
          mission_id: string;
          slug: string;
          title: string;
          description: string | null;
          lab: WlaLab;
          min_age: number;
          max_age: number;
          duration: string | null;
          delivery_type: MissionDelivery;
          cover_image: string | null;
          status: MissionStatus;
          current_screen_key: string | null;
          last_activity_at: string | null;
          mission_version: number | null;
        }[];
      };
      child_session_mission: {
        Args: { p_token: string; p_mission_slug: string };
        Returns: {
          mission_id: string;
          slug: string;
          title: string;
          description: string | null;
          lab: WlaLab;
          min_age: number;
          max_age: number;
          duration: string | null;
          delivery_type: MissionDelivery;
          cover_image: string | null;
          status: MissionStatus;
          mission_version: number | null;
          progress_id: string | null;
          current_screen_key: string | null;
          completion_rule: Json | null;
        }[];
      };
      child_session_start_mission: {
        Args: { p_token: string; p_mission_id: string };
        Returns: MissionProgressRow;
      };
      child_session_current_screen: {
        Args: { p_token: string; p_mission_id: string };
        Returns: {
          screen_key: string;
          type: ScreenTypeDb;
          title: string | null;
          body: string | null;
          sequence: number;
          configuration: Json;
          next_sequence_key: string | null;
        }[];
      };
      child_session_persist_state: {
        Args: {
          p_token: string;
          p_progress_id: string;
          p_state: Json;
          p_screen_key?: string | null;
          p_response_key?: string | null;
          p_response_value?: Json;
        };
        Returns: MissionProgressRow;
      };
      child_session_complete_mission: {
        Args: {
          p_token: string;
          p_progress_id: string;
          p_state: Json;
          p_trail?: Json;
        };
        Returns: MissionProgressRow;
      };
      child_session_record_event: {
        Args: { p_token: string; p_mission_id: string; p_name: string };
        Returns: undefined;
      };
      child_session_state: {
        Args: { p_token: string; p_progress_id: string };
        Returns: Json;
      };
      child_session_trail: {
        Args: { p_token: string; p_mission_slug: string };
        Returns: {
          id: string;
          type: EvidenceType;
          title: string;
          description: string | null;
          created_at: string;
          /** Evidence v2 (0034). */
          evidence_key: string | null;
          related_to: string | null;
          relation: MissionEvidenceRow["relation"];
          source: "completion" | "mission";
          screen_key: string | null;
        }[];
      };
      child_session_resources: {
        Args: { p_token: string; p_mission_slug: string };
        Returns: {
          id: string;
          title: string;
          description: string | null;
          type: ResourceType;
          storage_path: string;
          can_view: boolean;
          can_print: boolean;
          can_download: boolean;
          sort_order: number;
        }[];
      };
    };
    Enums: {
      mission_version_status: MissionVersionStatus;
      mission_status: MissionStatus;
      entitlement_source: EntitlementSource;
      entitlement_status: EntitlementStatus;
      mission_delivery: MissionDelivery;
      wla_lab: WlaLab;
      screen_type: ScreenTypeDb;
      resource_type: ResourceType;
      evidence_type: EvidenceType;
      review_attribution: ReviewAttribution;
      review_status: ReviewStatus;
    };
    CompositeTypes: { [_ in never]: never };
  };
};
