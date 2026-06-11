"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** /app → the Pay tab (the primary product surface). */
export default function AppIndex() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/app/pay");
  }, [router]);
  return null;
}
