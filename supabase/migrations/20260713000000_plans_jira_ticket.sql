-- Add an optional Jira ticket reference to plans.
-- Free-form: either a bare key ("NOC-2359") or a full URL, not validated
-- against any one Jira site's format.
alter table plans add column if not exists jira_ticket text;
