import { signInAction } from "@/app/actions";
import { Message } from "@/components/form-message";
import { Button } from "@/components/ui/button";

export default async function Login(props: { searchParams: Promise<Message> }) {
  return (
    <Button onClick={signInAction}>
    Sign in
  </Button>
  );
}
