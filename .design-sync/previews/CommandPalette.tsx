import { CommandPalette } from "@pawtograder/webapp";

const files: any[] = [
  { id: 1, name: "src/BinarySearchTree.java" },
  { id: 2, name: "src/Node.java" },
  { id: 3, name: "src/TreeTraversal.java" },
  { id: 4, name: "test/BinarySearchTreeTest.java" },
  { id: 5, name: "README.md" }
];

export const FileSearch = () => (
  <CommandPalette files={files} isOpen onClose={() => {}} onSelectFile={() => {}} />
);

const symbols = [
  { name: "insert", fileId: 1, line: 24, kind: "method" },
  { name: "delete", fileId: 1, line: 58, kind: "method" },
  { name: "inOrderTraversal", fileId: 3, line: 12, kind: "method" }
];

export const SymbolSearch = () => (
  <CommandPalette
    files={files}
    isOpen
    onClose={() => {}}
    onSelectFile={() => {}}
    mode="symbol"
    symbols={symbols}
    onSelectSymbol={() => {}}
  />
);
