export default async function Layout({ children }: { children: React.ReactNode }) {
  return (
    <main id="main-content" tabIndex={-1} className="max-w-7xl flex flex-col gap-12 items-start">
      {children}
    </main>
  );
}
