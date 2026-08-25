export function paginateItemsByHeight(heights, headingHeight, pageContentHeightPx) {
  const pages = []
  let current = []
  let currentHeight = 0
  heights.forEach((height, index) => {
    const budget = pageContentHeightPx - (pages.length === 0 ? headingHeight : 0)
    if (current.length > 0 && currentHeight + height > budget) {
      pages.push(current)
      current = []
      currentHeight = 0
    }
    current.push(index)
    currentHeight += height
  })
  if (current.length > 0)
    pages.push(current)
  return pages
}

export function groupFragmentsByBlockId(indexes, items) {
  const runs = []
  indexes.forEach((index) => {
    const item = items[index]
    const last = runs.at(-1)
    if (last && last.blockId === item.blockId)
      last.indexes.push(index)
    else
      runs.push({ blockId: item.blockId, blockType: item.blockType, groupClassName: item.groupClassName, indexes: [index] })
  })
  return runs
}
