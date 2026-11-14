import LoginPage from "@/components/login-page";
import { uuid } from "@/lib/validation";

export default async function Page({ searchParams }: { searchParams: Promise<{ pair?: string | string[] }> }) {
  const { pair } = await searchParams;
  let next: string | undefined;
  try { next = `/admin/pair-device?request=${uuid(pair)}`; } catch { }
  return <LoginPage admin next={next} />;
}
