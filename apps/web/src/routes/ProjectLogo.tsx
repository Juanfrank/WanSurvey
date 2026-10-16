/** A project's logo, when it has one (the address changes with the image, for caches). */
export function ProjectLogo({
  project,
  className = 'h-8 w-auto max-w-[8rem]',
}: {
  project: { id: string; logoUpdatedAt?: string | null };
  className?: string;
}) {
  if (!project.logoUpdatedAt) return null;
  return (
    <img
      src={`/api/v1/projects/${project.id}/logo?v=${Date.parse(project.logoUpdatedAt)}`}
      alt=""
      className={`object-contain ${className}`}
      data-testid="project-logo"
    />
  );
}
