import { useLayoutEffect, useRef, useState } from 'react'
import { useSelector } from 'react-redux'
import { splitEntryIntoFragments } from '@/components/CvSmart/templates/engine/entryFragments'
import { PaginatedEntryPages } from '@/components/CvSmart/templates/engine/PaginatedEntryPages'
import { usePaginatedGroups } from '@/components/CvSmart/templates/engine/usePaginatedGroups'
import coverBg from '@/images/cv-templates/visian/cover-bg.png'
import innerBg from '@/images/cv-templates/visian/inner-bg.png'
import '@/components/CvSmart/templates/visianSmartCv.css'

const CANVAS_W = 1263
const CANVAS_H = 893
const COVER_BAND_PX = 215
const COVER_BAND_RATIO = `1263 / ${COVER_BAND_PX}`
const COVER_CONTENT_TOP_PX = COVER_BAND_PX + 0.02 * CANVAS_W
const COVER_CONTENT_TOP_PCT = `${(COVER_CONTENT_TOP_PX / CANVAS_W * 100).toFixed(2)}%`
const COVER_CONTENT_BOTTOM_PX = CANVAS_H - 828 + 25
const COVER_CONTENT_HEIGHT_RATIO = (CANVAS_H - COVER_CONTENT_TOP_PX - COVER_CONTENT_BOTTOM_PX) / CANVAS_W
const INNER_BAND_PX = 155
const INNER_BAND_RATIO = `1263 / ${INNER_BAND_PX}`
const CONTENT_SIDE_PADDING_RATIO = 0.08
const CONTENT_TOP_MARGIN_PX = 20
const CONTENT_BOTTOM_MARGIN_PX = 90
const INNER_CONTENT_HEIGHT_RATIO = (CANVAS_H - INNER_BAND_PX - CONTENT_TOP_MARGIN_PX - CONTENT_BOTTOM_MARGIN_PX) / CANVAS_W
// Gouttière entre les deux colonnes de la couverture (gap-6 = 1.5rem = 24px).
const COVER_COLUMNS_GAP_PX = 24

function SkillGroup({ title, categories, blockId }) {
  if (!categories?.length)
    return null
  return (
    <div className="mb-2" data-block-type="skill-group" data-block-id={blockId}>
      <p className="visian-smart-heading text-[0.72em] font-bold tracking-wide text-gray-900">{title}</p>
      {categories.map(category => (
        <p key={category.name} className="text-[0.68em] text-gray-700">
          <span className="font-semibold">
            {category.name}
            {' : '}
          </span>
          {category.content?.map(item => item.text).join(', ')}
        </p>
      ))}
    </div>
  )
}

function DescriptionList({ description, variant = 'full' }) {
  if (!description?.length)
    return null
  return (
    <div className="mt-0.5 space-y-0.5 text-[0.68em] text-gray-700">
      {description.map((item) => {
        if (item.type === 'paragraph')
          return <p key={item.text}>{item.text}</p>
        const isIndented = variant === 'summary' && item.type === 'list-indent-1'
        const bullet = variant === 'summary'
          ? (item.type === 'list' ? '•' : isIndented ? 'o' : '§')
          : '•'
        // Puce toujours sur un <span> à part avec une taille explicite (jamais inline/hérité) :
        // ce template sert d'exemple à d'autres générations, sa taille de puce (1em ici) est
        // celle qui convient à SON design, recalibre-la (0.5-0.7em pour un glyphe plein, 1.3-1.4em
        // pour un "•" isolé) pour chaque nouveau template selon l'image cible.
        return (
          <div key={item.text} className={`flex items-baseline gap-1 ${isIndented ? 'pl-8' : 'pl-4'}`}>
            <span className="shrink-0 text-[1em] leading-none">{bullet}</span>
            <span className="min-w-0">{item.text}</span>
          </div>
        )
      })}
    </div>
  )
}

function ExperienceEntry({ experience, variant = 'full', blockId }) {
  return (
    <div className="mb-2.5" data-block-type="experience" data-block-id={blockId}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="visian-smart-heading text-[0.75em] font-bold text-gray-900">{experience.company}</p>
        {experience.period && <p className="shrink-0 text-[0.62em] text-gray-400">{experience.period}</p>}
      </div>
      {experience.job_title && <p className="text-[0.7em] font-semibold text-orange-600">{experience.job_title}</p>}
      {experience.projects_context && (
        <p className="text-[0.62em] text-gray-400 italic">
          Contexte :
          {' '}
          {experience.projects_context}
        </p>
      )}
      <DescriptionList description={experience.description} variant={variant} />
      {experience.technical_environment && (
        <p className="mt-0.5 text-[0.62em] text-gray-400 italic">
          Environnement technique :
          {' '}
          {experience.technical_environment}
        </p>
      )}
    </div>
  )
}

function EntryHeaderLines({ title, subtitle, period, context }) {
  return (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <p className="visian-smart-heading text-[0.75em] font-bold text-gray-900">{title}</p>
        {period && <p className="shrink-0 text-[0.62em] text-gray-400">{period}</p>}
      </div>
      {subtitle && <p className="text-[0.7em] font-semibold text-orange-600">{subtitle}</p>}
      {context && (
        <p className="text-[0.62em] text-gray-400 italic">
          Contexte :
          {' '}
          {context}
        </p>
      )}
    </>
  )
}

function DescriptionItemLine({ item }) {
  if (item.type === 'paragraph')
    return <p className="text-[0.68em] text-gray-700">{item.text}</p>
  return (
    <p className="pl-4 text-[0.68em] text-gray-700">
      •
      {' '}
      {item.text}
    </p>
  )
}

function TechEnvLine({ text }) {
  return (
    <p className="mt-0.5 text-[0.62em] text-gray-400 italic">
      Environnement technique :
      {' '}
      {text}
    </p>
  )
}

function CoverHeader({ personalInformation }) {
  return (
    <div className="visian-smart-header flex flex-col items-center justify-center gap-0.5 px-[8%] text-center" data-block-type="personal_information" data-block-id="personal_information" style={{ aspectRatio: COVER_BAND_RATIO }}>
      <p className="visian-smart-heading text-[1.5em] font-extrabold text-orange-400">{personalInformation.trigram}</p>
      <p className="visian-smart-heading text-[0.95em] font-bold text-white">{personalInformation.job_title}</p>
      {personalInformation.nb_exp_years != null && (
        <p className="text-[0.8em] font-semibold text-white">
          +
          {personalInformation.nb_exp_years}
          {' '}
          ANS D'EXPÉRIENCE
        </p>
      )}
      {personalInformation.main_tools && (
        <p className="text-[0.7em] font-semibold text-sky-300 italic">{personalInformation.main_tools}</p>
      )}
      {personalInformation.introduction && (
        <p className="visian-smart-clamp-2 mt-0.5 max-w-2xl text-[0.6em] text-white/90 italic">{personalInformation.introduction}</p>
      )}
    </div>
  )
}

function InnerHeader({ personalInformation }) {
  return (
    <div className="visian-smart-header flex flex-col items-center justify-center gap-0.5 px-[8%] text-center" style={{ aspectRatio: INNER_BAND_RATIO }}>
      <p className="visian-smart-heading text-[1.1em] font-extrabold text-orange-400">{personalInformation.trigram}</p>
      <p className="visian-smart-heading text-[0.85em] font-bold text-white">{personalInformation.job_title}</p>
      {personalInformation.nb_exp_years != null && (
        <p className="text-[0.7em] font-semibold text-white">
          +
          {personalInformation.nb_exp_years}
          {' '}
          ans d'expérience
        </p>
      )}
    </div>
  )
}

function PageFooter() {
  const saleInfo = useSelector(state => state.auth.saleInfo)
  return (
    <p className="absolute right-[8%] bottom-[3%] text-right text-[0.55em] whitespace-pre-line text-gray-500">
      VISIAN – Entité du groupe Neurones
      {'\n'}
      Contact :
      {' '}
      {saleInfo?.email}
      {' '}
      –
      {' '}
      {saleInfo?.phone_number}
    </p>
  )
}

function VisianInnerPageChrome({ personalInformation, children }) {
  return (
    <div className="visian-smart-page" style={{ backgroundImage: `url(${innerBg})` }}>
      <InnerHeader personalInformation={personalInformation} />
      <PageFooter />
      <div className="px-[8%]" style={{ paddingTop: `${(INNER_BAND_PX / CANVAS_W * 100).toFixed(2)}%`, marginTop: `${(CONTENT_TOP_MARGIN_PX / CANVAS_W * 100).toFixed(2)}%` }}>
        {children}
      </div>
    </div>
  )
}

// Chrome de la page 1 : bandeau d'identité + pied de page fixes, contenu en flux.
function VisianCoverPageChrome({ personalInformation, children }) {
  return (
    <div className="visian-smart-page" style={{ backgroundImage: `url(${coverBg})` }}>
      <CoverHeader personalInformation={personalInformation} />
      <PageFooter />
      <div className="px-[6%]" style={{ paddingTop: COVER_CONTENT_TOP_PCT }}>
        {children}
      </div>
    </div>
  )
}

// Couverture à DEUX COLONNES qui pagine : chaque colonne est découpée en pages
// par le moteur (usePaginatedGroups, un appel par colonne), puis la page k
// affiche le groupe k de gauche à côté du groupe k de droite : ce qui ne tient
// pas sur la page 1 passe sur la suivante au lieu d'être coupé ou de sortir de
// la page.
// Un item par bloc indivisible ; le titre de colonne est porté par le 1er item.
function PaginatedCoverColumns({ containerWidth, leftItems, rightItems, pageContentHeightPx, renderPageChrome }) {
  const left = usePaginatedGroups({ items: leftItems, containerWidth, pageContentHeightPx })
  const right = usePaginatedGroups({ items: rightItems, containerWidth, pageContentHeightPx })
  // Largeur de mesure volontairement un peu étroite (marges de 8 % des pages
  // intérieures) : on mesure au pire cas, jamais plus large que le rendu.
  const columnWidthPx = containerWidth ? (containerWidth * (1 - 2 * CONTENT_SIDE_PADDING_RATIO) - COVER_COLUMNS_GAP_PX) / 2 : 0
  const pageCount = Math.max(left.groups?.length ?? 0, right.groups?.length ?? 0)

  const renderColumn = (items, indexes) => (indexes ?? []).map(index => <div key={items[index].key}>{items[index].render()}</div>)
  const measureColumn = (items, itemsRef) => (
    <div style={{ position: 'fixed', top: 0, left: -99999, width: columnWidthPx }} aria-hidden="true">
      {items.map((item, index) => (
        <div key={item.key} ref={(el) => { itemsRef.current[index] = el }} style={{ display: 'flow-root' }}>
          {item.render()}
        </div>
      ))}
    </div>
  )

  return (
    <>
      {measureColumn(leftItems, left.itemsRef)}
      {measureColumn(rightItems, right.itemsRef)}
      {Array.from({ length: pageCount }, (_, pageIndex) => (
        <div key={pageIndex}>
          {renderPageChrome({
            pageIndex,
            children: (
              <div className="flex gap-6">
                <div className="w-1/2">{renderColumn(leftItems, left.groups?.[pageIndex])}</div>
                <div className="w-1/2">{renderColumn(rightItems, right.groups?.[pageIndex])}</div>
              </div>
            ),
          })}
        </div>
      ))}
    </>
  )
}

function VisianTemplateHtml({ cvData }) {
  const rootRef = useRef(null)
  const [containerWidth, setContainerWidth] = useState(null)

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root)
      return
    const measure = () => setContainerWidth(root.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  const innerHeadingClassName = 'visian-smart-heading mb-2 text-[0.78em] font-bold tracking-wide text-gray-900 uppercase'
  const pageContentHeightPx = containerWidth ? containerWidth * INNER_CONTENT_HEIGHT_RATIO : 0
  // Budget unique pour la couverture ET ses pages de suite : on prend le plus petit.
  const coverContentHeightPx = containerWidth ? containerWidth * Math.min(COVER_CONTENT_HEIGHT_RATIO, INNER_CONTENT_HEIGHT_RATIO) : 0

  const personalInformation = cvData?.personal_information ?? {}
  const technicalSkills = cvData?.technical_skills ?? []
  const functionalSkills = cvData?.functional_skills ?? []
  const languages = cvData?.languages ?? []
  const formations = cvData?.formations ?? []
  const certifications = cvData?.certifications ?? []
  const experiences = cvData?.experiences ?? []
  const experiencesSummary = (cvData?.experiences_summary?.length ? cvData.experiences_summary : experiences)
    .slice(0, 4)
    .map(experience => ({ ...experience, description: (experience.description ?? []).slice(0, 3) }))
  const personalProjects = cvData?.personal_projects ?? []

  // Couverture : un item par bloc indivisible, pour que chaque colonne puisse
  // continuer sur la page suivante (voir PaginatedCoverColumns).
  const columnHeadingClassName = 'visian-smart-heading mb-2 text-[0.78em] font-bold tracking-wide uppercase'
  const summaryItems = experiencesSummary.map((experience, index) => ({
    key: `summary-${index}-${experience.company}`,
    render: () => (
      <>
        {index === 0 && (
          <p className={`${columnHeadingClassName} text-gray-900`}>
            Aperçu des
            {' '}
            <span className="text-orange-600">expériences significatives</span>
          </p>
        )}
        <ExperienceEntry experience={experience} variant="summary" blockId={`experiences_summary-${index}`} />
      </>
    ),
  }))
  const skillsBlocks = [
    technicalSkills.length > 0 && {
      key: 'technical_skills',
      render: () => <SkillGroup title="Techniques" categories={technicalSkills} blockId="technical_skills" />,
    },
    functionalSkills.length > 0 && {
      key: 'functional_skills',
      render: () => <SkillGroup title="Fonctionnelles" categories={functionalSkills} blockId="functional_skills" />,
    },
    languages.length > 0 && {
      key: 'languages',
      render: () => (
        <p className="mb-2 text-[0.68em] text-gray-700">
          <span className="font-bold">Langues : </span>
          {languages.map(language => `${language.name} ${language.content}`).join(', ')}
        </p>
      ),
    },
    formations.length > 0 && {
      key: 'formations',
      render: () => (
        <div data-block-type="formation" data-block-id="formations">
          <p className="visian-smart-heading text-[0.72em] font-bold tracking-wide text-gray-900">Formation</p>
          <ul className="space-y-0.5 text-[0.68em] text-gray-700">
            {formations.map(formation => (
              <li key={`${formation.name}-${formation.school}`}>
                {formation.school && `${formation.school} : `}
                {formation.name}
              </li>
            ))}
          </ul>
        </div>
      ),
    },
  ].filter(Boolean)
  const skillsItems = skillsBlocks.map((block, index) => (index === 0
    ? {
        ...block,
        render: () => (
          <>
            <p className={`${columnHeadingClassName} text-orange-600`}>Compétences</p>
            {block.render()}
          </>
        ),
      }
    : block))

  const entryRenderers = {
    renderHeader: props => <EntryHeaderLines {...props} />,
    renderBullet: item => <DescriptionItemLine item={item} />,
    renderTechEnv: text => <TechEnvLine text={text} />,
  }

  const experienceItems = experiences.flatMap((experience, index) => splitEntryIntoFragments({
    blockId: `experiences-${index}`,
    blockType: 'experience',
    title: experience.company,
    subtitle: experience.job_title,
    period: experience.period,
    context: experience.projects_context,
    description: experience.description,
    technicalEnvironment: experience.technical_environment,
    ...entryRenderers,
  }))
  const projectItems = personalProjects.flatMap((project, index) => splitEntryIntoFragments({
    blockId: `personal_projects-${index}`,
    blockType: 'project',
    title: project.name,
    subtitle: project.job_title,
    context: project.context,
    description: project.description,
    technicalEnvironment: project.technical_environment,
    ...entryRenderers,
  }))
  const certificationItems = certifications.map((certification, index) => ({
    key: certification.name,
    blockId: `certifications-${index}`,
    blockType: 'certification',
    render: () => <p className="text-[0.7em] text-gray-700">{certification.name}</p>,
  }))

  return (
    <div ref={rootRef} className="mx-auto flex max-w-xl flex-col gap-6" style={{ fontSize: containerWidth ? `${(containerWidth * (20 / CANVAS_W)).toFixed(2)}px` : '20px' }}>

      {containerWidth && (summaryItems.length > 0 || skillsItems.length > 0) && (
        <PaginatedCoverColumns
          containerWidth={containerWidth}
          leftItems={summaryItems}
          rightItems={skillsItems}
          pageContentHeightPx={coverContentHeightPx}
          renderPageChrome={({ pageIndex, children }) => (pageIndex === 0
            ? <VisianCoverPageChrome personalInformation={personalInformation}>{children}</VisianCoverPageChrome>
            : <VisianInnerPageChrome personalInformation={personalInformation}>{children}</VisianInnerPageChrome>)}
        />
      )}

      {containerWidth && experienceItems.length > 0 && (
        <PaginatedEntryPages
          containerWidth={containerWidth}
          items={experienceItems}
          headingClassName={innerHeadingClassName}
          pageContentHeightPx={pageContentHeightPx}
          contentSidePaddingRatio={CONTENT_SIDE_PADDING_RATIO}
          renderPageChrome={({ children }) => (
            <VisianInnerPageChrome personalInformation={personalInformation}>{children}</VisianInnerPageChrome>
          )}
        />
      )}

      {containerWidth && projectItems.length > 0 && (
        <PaginatedEntryPages
          containerWidth={containerWidth}
          items={projectItems}
          heading="Projets personnels"
          headingClassName={innerHeadingClassName}
          pageContentHeightPx={pageContentHeightPx}
          contentSidePaddingRatio={CONTENT_SIDE_PADDING_RATIO}
          renderPageChrome={({ children }) => (
            <VisianInnerPageChrome personalInformation={personalInformation}>{children}</VisianInnerPageChrome>
          )}
        />
      )}

      {containerWidth && certificationItems.length > 0 && (
        <PaginatedEntryPages
          containerWidth={containerWidth}
          items={certificationItems}
          heading="Certifications"
          headingClassName={innerHeadingClassName}
          pageContentHeightPx={pageContentHeightPx}
          contentSidePaddingRatio={CONTENT_SIDE_PADDING_RATIO}
          renderPageChrome={({ children }) => (
            <VisianInnerPageChrome personalInformation={personalInformation}>{children}</VisianInnerPageChrome>
          )}
        />
      )}
    </div>
  )
}

export default VisianTemplateHtml
