import { groupFragmentsByBlockId } from '@/components/CvSmart/templates/engine/paginationEngine'
import { usePaginatedGroups } from '@/components/CvSmart/templates/engine/usePaginatedGroups'

export function PaginatedEntryPages({
  containerWidth,
  items,
  heading,
  headingClassName,
  pageContentHeightPx,
  contentSidePaddingRatio,
  renderPageChrome,
}) {
  const { groups, itemsRef, headingRef } = usePaginatedGroups({ items, containerWidth, pageContentHeightPx })
  const contentWidthPx = containerWidth ? containerWidth * (1 - 2 * contentSidePaddingRatio) : 0

  return (
    <>
      <div style={{ position: 'fixed', top: 0, left: -99999, width: contentWidthPx }} aria-hidden="true">
        {heading && <p ref={headingRef} className={headingClassName}>{heading}</p>}
        {items.map((item, index) => (
          <div key={item.key} ref={(el) => { itemsRef.current[index] = el }}>
            {item.render()}
          </div>
        ))}
      </div>

      {groups && groups.map((indexes, pageIndex) => (
        <div key={indexes[0]}>
          {renderPageChrome({
            children: (
              <>
                {pageIndex === 0 && heading && <p className={headingClassName}>{heading}</p>}
                {groupFragmentsByBlockId(indexes, items).map(run => (
                  <div
                    key={run.indexes[0]}
                    data-block-type={run.blockType}
                    data-block-id={run.blockId}
                    className={`cv-smart-fragment-group ${run.groupClassName ?? ''}`}
                  >
                    {run.indexes.map(index => <div key={items[index].key}>{items[index].render()}</div>)}
                  </div>
                ))}
              </>
            ),
          })}
        </div>
      ))}
    </>
  )
}
