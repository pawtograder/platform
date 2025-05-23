import Login from "./(auth-pages)/sign-in/page";
import { Message } from "@/components/form-message";
import Layout from "./(auth-pages)/layout";

export default async function Home({ searchParams }: { searchParams: Promise<Message> }) {
  return (
    <Layout>
      <Login searchParams={searchParams} />
    </Layout>
  );
}
