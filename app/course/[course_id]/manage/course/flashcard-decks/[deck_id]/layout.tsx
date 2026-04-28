import FlashcardDeckLayoutClient from "./layout-client";

export const metadata = {
  title: "Flashcard Deck"
};

export default function FlashcardDeckLayout({ children }: { children: React.ReactNode }) {
  return <FlashcardDeckLayoutClient>{children}</FlashcardDeckLayoutClient>;
}
