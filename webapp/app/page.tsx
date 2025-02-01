import { Button } from "@/components/ui/button";
import { signInAction } from "./actions";

export default async function Home() {
  return (
    <Button onClick={signInAction}>
    Sign in
  </Button>
  );
}
