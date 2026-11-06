/**
 * Every illustration the app can show, in one place. Pages ask for a name
 * (<Illustration name="employees.empty" />) and never import SVG files, so
 * adding or swapping art means: drop the optimized file in ./svg, add one
 * entry here, and record its license in ./LICENSES.md.
 *
 * Use them sparingly: first-run empty states and the not-found page. Lists
 * that are empty because of a filter keep the small icon instead.
 */

export type IllustrationCategory = 'dashboard' | 'recruitment' | 'employees' | 'payroll' | 'leave' | 'documents' | 'sales' | 'empty';

export interface IllustrationEntry {
  /** file in ./svg, without .svg */
  file: string;
  category: IllustrationCategory;
  /** what the picture shows, for screen readers when it is not decorative */
  alt: string;
  /** viewBox width ÷ height, so the space is reserved before the file arrives */
  ratio: number;
  source: 'Open Doodles' | 'Open Peeps';
}

const WIDE = 1024 / 768;

export const ILLUSTRATIONS = {
  'dashboard.getting-started': { file: 'sitting-reading', category: 'dashboard', alt: 'A person reading in a chair beside a stack of books', ratio: WIDE, source: 'Open Doodles' },
  'recruitment.empty': { file: 'strolling', category: 'recruitment', alt: 'A person walking in with long strides', ratio: WIDE, source: 'Open Doodles' },
  'employees.empty': { file: 'team', category: 'employees', alt: 'Three colleagues: one sitting, one standing, one walking', ratio: 513 / 597, source: 'Open Peeps' },
  'payroll.empty': { file: 'unboxing', category: 'payroll', alt: 'A person climbing out of an opened box', ratio: WIDE, source: 'Open Doodles' },
  'leave.all-clear': { file: 'chilling', category: 'leave', alt: 'A person relaxing on the floor, hands behind their head', ratio: WIDE, source: 'Open Doodles' },
  'leave.empty': { file: 'meditating', category: 'leave', alt: 'A person meditating cross-legged', ratio: WIDE, source: 'Open Doodles' },
  'documents.empty': { file: 'reading', category: 'documents', alt: 'A person sitting and reading a book', ratio: WIDE, source: 'Open Doodles' },
  'sales.empty': { file: 'jumping', category: 'sales', alt: 'A person jumping for joy', ratio: WIDE, source: 'Open Doodles' },
  'empty.not-found': { file: 'levitate', category: 'empty', alt: 'A person floating in the air', ratio: WIDE, source: 'Open Doodles' },
} as const satisfies Record<string, IllustrationEntry>;

export type IllustrationName = keyof typeof ILLUSTRATIONS;
