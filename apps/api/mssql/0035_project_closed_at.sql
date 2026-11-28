-- When a project was closed: fieldwork stops then, and a device may still send back the
-- interviews started before that moment. Set when the project is closed (or archived without
-- having been closed), cleared when it is reopened.
ALTER TABLE dbo.projects ADD closed_at datetimeoffset(3) NULL;
--> statement-breakpoint
-- Projects closed before: the first closing (or archiving) after their last reopening, as the
-- activity log saw it; else now.
UPDATE p SET closed_at = COALESCE(
  (SELECT MIN(a.at) FROM dbo.audit_log a
    WHERE a.tenant_id = p.tenant_id AND a.action = N'project.updated'
      AND a.target_ref = LOWER(CONVERT(nvarchar(450), p.id))
      AND JSON_VALUE(a.details, '$.status') IN (N'closed', N'archived')
      AND a.at > COALESCE(
        (SELECT MAX(o.at) FROM dbo.audit_log o
          WHERE o.tenant_id = p.tenant_id AND o.action = N'project.updated'
            AND o.target_ref = LOWER(CONVERT(nvarchar(450), p.id))
            AND JSON_VALUE(o.details, '$.status') IN (N'active', N'draft')),
        CAST('0001-01-01T00:00:00+00:00' AS datetimeoffset(3)))),
  SYSDATETIMEOFFSET())
FROM dbo.projects p
WHERE p.status IN (N'closed', N'archived');
