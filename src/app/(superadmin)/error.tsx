"use client"

import { PageError } from "@/components/shared/page-error"

export default function PlatformError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return <PageError error={error} reset={reset} title="平台页出错了" />
}
