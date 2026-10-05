export const originalText = [
  'ALEX EXAMPLE',
  'alex@example.test | San Francisco, CA',
  'SUMMARY',
  'Software engineer building accessible web applications with TypeScript and React.',
  'EXPERIENCE',
  'Example Studio | Software Engineer | 2021 - 2025',
  'Built accessible interfaces and automated regression tests for customer workflows.',
  'SKILLS',
  'TypeScript, React, accessibility, automated testing',
].join('\n')

export const editedBaseText = `${originalText}\nReviewed source: maintained reliable API integrations with local data storage.`
export const jobDescription = 'Build accessible TypeScript and React applications for our product team. Maintain automated tests, collaborate with designers, and review API integrations. Kubernetes experience is preferred.'
export const summary = 'Prioritized the existing TypeScript, React, and accessibility experience for this role.'
export const gap = 'Kubernetes experience is not evidenced in the base resume.'

// Exact fixture key, not a language-classification heuristic. All data is fictional.
export const frenchJobDescription = 'Rejoignez Example Labs pour développer des applications accessibles avec TypeScript et React. Vous collaborerez avec les équipes de conception et maintiendrez les tests automatisés. Une expérience de Kubernetes est souhaitée.'
export const frenchResumeText = [
  'ALEX EXAMPLE',
  'alex@example.test | San Francisco, CA',
  'PROFIL',
  'Ingénieur logiciel créant des applications web accessibles avec TypeScript et React.',
  'EXPÉRIENCE',
  'Example Studio | Ingénieur logiciel | 2021 - 2025',
  'Création d’interfaces accessibles et de tests de régression automatisés pour les parcours clients.',
  'COMPÉTENCES',
  'TypeScript, React, accessibilité — tests automatisés',
].join('\n')
export const frenchSummary = 'Mise en valeur de l’expérience en TypeScript, React et accessibilité pour ce poste.'
export const frenchGap = 'L’expérience de Kubernetes n’est pas attestée dans le CV source.'
export const englishPairedText = `${originalText}\n\nROLE FOCUS\nTypeScript, React, accessibility — automated testing.`

// Complete fictional letters, not CV section lists or summaries. The French
// body deliberately exercises accents, curly apostrophes and an em dash in PDFs.
export const englishLetterText = [
  'ALEX EXAMPLE\nalex@example.test | San Francisco, CA',
  'DEAR HIRING TEAM,',
  'I am applying for the Frontend Engineer role at Example Labs. My experience building accessible web applications with TypeScript and React aligns with your need for accessible product interfaces and maintained automated tests.',
  'At Example Studio, where I worked as a Software Engineer from 2021 to 2025, I built accessible interfaces for customer workflows. This work provides a practical foundation for contributing to the interface development described in your job posting.',
  'I also built automated regression tests for those workflows. I would bring that experience to checking interface changes and maintaining tests alongside product development. My background connects accessible implementation with repeatable checks rather than treating either as a separate concern.',
  'Thank you for considering my application. I would welcome a conversation about how my experience with TypeScript, React, accessibility, and automated testing could support your team.',
  'Sincerely,\nAlex Example',
].join('\n\n')
export const frenchLetterText = [
  'ALEX EXAMPLE\nalex@example.test | San Francisco, CA',
  'MADAME, MONSIEUR,',
  'Je vous présente ma candidature au poste de Frontend Engineer chez Example Labs. Mon expérience de création d’applications web accessibles avec TypeScript et React correspond à vos besoins en interfaces accessibles et en maintenance des tests automatisés.',
  'Chez Example Studio, où j’ai travaillé comme ingénieur logiciel de 2021 à 2025, j’ai créé des interfaces accessibles pour les parcours clients. Cette expérience constitue une base concrète pour contribuer au développement des interfaces décrit dans votre offre.',
  'J’ai également créé des tests de régression automatisés pour ces parcours. Je pourrais mobiliser cette expérience pour vérifier les modifications des interfaces et maintenir les tests pendant le développement du produit. Mon parcours associe mise en œuvre accessible et vérifications reproductibles — deux dimensions complémentaires.',
  'Je vous remercie de l’attention portée à ma candidature. Je serais heureux de discuter de la manière dont mon expérience de TypeScript, React, de l’accessibilité et des tests automatisés pourrait contribuer à votre équipe.',
  'Cordialement,\nAlex Example',
].join('\n\n')
export const letterSummary = 'Connected the existing accessible-interface and regression-testing experience to the role in a cover letter.'
export const frenchLetterSummary = 'Présentation de l’expérience en interfaces accessibles et en tests de régression dans une lettre de motivation.'

// Translation-only fictional bodies. No downloaded fonts or live language service.
export const chineseTranslationText = [
  'ALEX EXAMPLE',
  'alex@example.test | San Francisco, CA',
  '个人简介',
  '软件工程师，使用 TypeScript 和 React 开发无障碍网页应用。',
  '工作经历',
  'Example Studio | 软件工程师 | 2021 - 2025',
  '为客户工作流程构建无障碍界面，并编写自动化回归测试。',
  '技能',
  'TypeScript、React、无障碍设计、自动化测试。',
].join('\n')
export const chineseLetterTranslationText = [
  'ALEX EXAMPLE\nalex@example.test | San Francisco, CA',
  '尊敬的招聘团队：',
  '我申请 Example Labs 的 Frontend Engineer 职位。我使用 TypeScript 和 React 开发无障碍网页应用，并为客户工作流程编写自动化测试。',
  '我于 2021 至 2025 年在 Example Studio 担任软件工程师，构建无障碍界面和自动化回归测试。我希望运用这些经验，为团队的界面开发和测试维护作出贡献。',
  '感谢您审阅我的申请。我期待有机会讨论我的相关工作经验。',
  '此致\nAlex Example',
].join('\n\n')