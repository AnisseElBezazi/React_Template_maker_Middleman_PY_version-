export function splitEntryIntoFragments({
  blockId,
  blockType,
  title,
  subtitle,
  period,
  context,
  description,
  technicalEnvironment,
  renderHeader,
  renderBullet,
  renderTechEnv,
  groupClassName = 'mb-2.5',
}) {
  const bullets = description ?? []
  const hasEnv = Boolean(technicalEnvironment)
  const fragments = []

  fragments.push({
    key: `${blockId}-head`,
    blockId,
    blockType,
    groupClassName,
    render: () => (
      <>
        {renderHeader({ title, subtitle, period, context })}
        {bullets.length > 0 && (
          <div className="mt-0.5">
            {renderBullet(bullets[0])}
          </div>
        )}
      </>
    ),
  })

  for (let i = 1; i < bullets.length; i++) {
    fragments.push({
      key: `${blockId}-b${i}`,
      blockId,
      blockType,
      groupClassName,
      render: () => renderBullet(bullets[i]),
    })
  }

  if (hasEnv) {
    fragments.push({
      key: `${blockId}-env`,
      blockId,
      blockType,
      groupClassName,
      render: () => renderTechEnv(technicalEnvironment),
    })
  }

  return fragments
}
