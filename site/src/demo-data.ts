export type DemoLine = {
  oldNumber?: number;
  newNumber?: number;
  before?: string;
  after?: string;
};

export type DemoHunk = {
  id: string;
  header: string;
  lines: DemoLine[];
};

export type DemoFile = {
  id: string;
  path: string;
  status: "A" | "M";
  hunks: DemoHunk[];
};

export const demoFiles: DemoFile[] = [
  {
    id: "navigation",
    path: "src/navigation.ts",
    status: "M",
    hunks: [
      {
        id: "navigation-wrap",
        header: "@@ -12,3 +12,4 @@",
        lines: [
          { oldNumber: 12, newNumber: 12, before: "export function nextView(current: View) {", after: "export function nextView(current: View) {" },
          { oldNumber: 13, newNumber: 13, before: "  return views[current + 1];", after: "  const index = views.indexOf(current);" },
          { newNumber: 14, after: "  return views[(index + 1) % views.length];" },
          { oldNumber: 14, newNumber: 15, before: "}", after: "}" },
        ],
      },
      {
        id: "navigation-shortcuts",
        header: "@@ -24,2 +25,3 @@",
        lines: [
          { oldNumber: 24, newNumber: 25, before: "export const shortcuts = {", after: "export const shortcuts = {" },
          { newNumber: 26, after: "  nextView: 'Mod+Alt+ArrowRight'," },
          { oldNumber: 25, newNumber: 27, before: "};", after: "};" },
        ],
      },
    ],
  },
  {
    id: "theme",
    path: "src/theme.ts",
    status: "M",
    hunks: [{
      id: "theme-preference",
      header: "@@ -1,3 +1,3 @@",
      lines: [
        { oldNumber: 1, newNumber: 1, before: "export const appearance = {", after: "export const appearance = {" },
        { oldNumber: 2, newNumber: 2, before: "  theme: 'light',", after: "  theme: 'system'," },
        { oldNumber: 3, newNumber: 3, before: "};", after: "};" },
      ],
    }],
  },
  {
    id: "test",
    path: "src/navigation.test.ts",
    status: "A",
    hunks: [{
      id: "navigation-test",
      header: "@@ -0,0 +1,4 @@",
      lines: [
        { newNumber: 1, after: "it('wraps to the first view', () => {" },
        { newNumber: 2, after: "  const last = views[views.length - 1];" },
        { newNumber: 3, after: "  expect(nextView(last)).toBe(views[0]);" },
        { newNumber: 4, after: "});" },
      ],
    }],
  },
];

export type DemoCommit = {
  hash: string;
  summary: string;
  ref?: string;
  time: string;
  graph?: "merge" | "side";
  fileIds: string[];
  hunkIds?: string[];
};

export const demoCommits: DemoCommit[] = [
  { hash: "a6f203d", summary: "Refine workspace navigation", ref: "main", time: "2 min ago", fileIds: ["navigation", "test"] },
  { hash: "9e72bc1", summary: "Merge branch 'feature/search'", graph: "merge", time: "18 min ago", fileIds: ["navigation"] },
  { hash: "c4d810a", summary: "Keep search results in view", ref: "feature/search", graph: "side", time: "32 min ago", fileIds: ["navigation"] },
  { hash: "0b73e6f", summary: "Follow the system appearance", time: "1 hour ago", fileIds: ["theme"] },
  { hash: "d891e3a", summary: "Cover keyboard navigation", time: "2 hours ago", fileIds: ["test"] },
];

export const allHunkIds = demoFiles.flatMap((file) => file.hunks.map((hunk) => hunk.id));

export const p4Changes = [
  { id: "41", summary: "Refine workspace navigation", fileId: "navigation", time: "12 min ago" },
  { id: "40", summary: "Follow the system appearance", fileId: "theme", time: "1 hour ago" },
  { id: "39", summary: "Cover keyboard navigation", fileId: "test", time: "Yesterday" },
];
