-- meltiply-release-phase: expand
-- Durable local publication measurements for the opt-in daily usage summary.
--
-- Publication success is counted when a Distribution row actually transitions
-- to `published`, inside the same transaction that records the transition, so
-- queued work, Provider attempts, retries, and Ambiguous outcomes never
-- contribute. The aggregates are installation-local: no Post, Distribution,
-- Channel or Workspace identifier ever leaves the installation, and none of
-- these tables is reachable from a tenant transaction (`meltiply_rls` is
-- revoked), so a member session can neither inspect nor forge measurements.
--
-- Deliberately absent: foreign keys to domain tables. Deleting a Post, a
-- Distribution or a Channel must not reduce a measurement that was already
-- taken, and a dedup mark must survive the record it describes.

-- One row per Post, written the first time any of its Distributions is
-- confirmed published, whether or not reporting is enabled. This is a domain
-- fact, not telemetry.
--
-- `counted` records whether that first success happened inside an effective
-- reporting interval. It is decided once, at the first success, so a Post whose
-- first success predates consent can never later be presented as a new Post when
-- its second Distribution succeeds after the Owner opts in, and an operator
-- force-off cannot be backfilled by a re-enable. Because the Post is the key,
-- counting `counted` rows over a day yields a cross-Platform distinct-Post total
-- rather than a sum of per-Platform Post counts.
CREATE TABLE reporting_post_marks (
    post_id            UUID PRIMARY KEY,
    first_confirmed_at TIMESTAMPTZ NOT NULL,
    counted            BOOLEAN NOT NULL
);

CREATE INDEX idx_reporting_post_marks_first_confirmed_at
    ON reporting_post_marks (first_confirmed_at) WHERE counted;

-- One row per Distribution whose success was observed. The key is the "each
-- Distribution once" guard: a reconciliation that re-observes `published`
-- inserts nothing, so the per-Platform counter cannot advance twice.
CREATE TABLE reporting_distribution_marks (
    distribution_id UUID PRIMARY KEY,
    platform        TEXT NOT NULL,
    confirmed_at    TIMESTAMPTZ NOT NULL
);

-- Pre-aggregated per-Platform Distribution counters, keyed by the consent
-- interval they were counted in. Re-enabling reporting starts a new interval,
-- so declined activity is never replayed and an old interval's rows stop being
-- reported. The daily bucket is bounded data that retention can prune; the marks
-- above stay as long as a live row could be re-observed.
--
-- No `posts` column: a Post's successful Distributions may span Platforms, so a
-- per-Platform Post count cannot be added up into a distinct-Post total. That
-- total comes from `reporting_post_marks`.
CREATE TABLE reporting_publication_daily (
    interval_started_at TIMESTAMPTZ NOT NULL,
    report_date         DATE NOT NULL,
    platform            TEXT NOT NULL,
    distributions       INTEGER NOT NULL DEFAULT 0,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (interval_started_at, report_date, platform),
    CONSTRAINT reporting_publication_daily_count_check CHECK (distributions > 0)
);

CREATE INDEX idx_reporting_publication_daily_report_date
    ON reporting_publication_daily (report_date);

-- The engagement cohort is the newest published Distributions, read newest
-- first under a hard bound. This partial index serves that order directly, so a
-- daily pass never sorts the whole publication history.
CREATE INDEX idx_distributions_usage_published_cohort
    ON distributions (published_at DESC, id DESC)
    WHERE status = 'published';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_system') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON reporting_post_marks,
                 reporting_distribution_marks, reporting_publication_daily
                 TO meltiply_system';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_rls') THEN
        EXECUTE 'REVOKE ALL ON reporting_post_marks, reporting_distribution_marks,
                 reporting_publication_daily FROM meltiply_rls';
    END IF;
END;
$$;
