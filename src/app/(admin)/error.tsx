"use client"

import { PageError } from "@/components/shared/page-error"

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return <PageError error={error} reset={reset} title="管理页出错了" />
}
