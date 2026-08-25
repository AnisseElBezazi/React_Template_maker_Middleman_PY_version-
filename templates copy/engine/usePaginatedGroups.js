import { useLayoutEffect, useRef, useState } from 'react'
import { paginateItemsByHeight } from '@/components/CvSmart/templates/engine/paginationEngine'

export function usePaginatedGroups({ items, containerWidth, pageContentHeightPx }) {
  const itemsRef = useRef([])
  const headingRef = useRef(null)
  const [groups, setGroups] = useState(null)
  const itemsKey = items.map(item => item.key).join(' ')

  useLayoutEffect(() => {
    if (!containerWidth)
      return
    itemsRef.current.length = items.length
    const heights = itemsRef.current.map(el => el?.getBoundingClientRect().height ?? 0)
    const headingHeight = headingRef.current?.getBoundingClientRect().height ?? 0
    setGroups(paginateItemsByHeight(heights, headingHeight, pageContentHeightPx))
  }, [containerWidth, pageContentHeightPx, itemsKey, items.length])

  return { groups, itemsRef, headingRef }
}
