import { auth } from "./auth";

export async function getRequiredUser() {
  const session = await auth();
  if (!session?.user?.id) {
    return null;
  }
  return { id: session.user.id, name: session.user.name, email: session.user.email };
}
