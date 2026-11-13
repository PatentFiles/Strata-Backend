import { useAuth } from '@clerk/react';
import { getGetPhase4AccountQueryKey, useGetPhase4Account } from '@workspace/api-client-react';

export default function KeyProvisioningLink() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const { data: account, isSuccess, isFetching } = useGetPhase4Account({
    query: {
      enabled: import.meta.env.DEV && !!isLoaded && !!isSignedIn && !!userId,
      queryKey: [...getGetPhase4AccountQueryKey(), 'provisioning-owner', userId],
      retry: false,
    },
  });

  // The account endpoint only returns a successful response for the configured
  // Phase 4 owner. Keep cached data scoped to the active Clerk user.
  if (!import.meta.env.DEV || !isLoaded || !isSignedIn || !userId ||
      !isSuccess || isFetching || !account) return null;

  return (
    <div className="mt-4 rounded-[12px] border border-[#d6d0c1] bg-[#f8f5ed] px-5 py-4">
      <p className="mb-2 text-[12px] text-[#596271]">Owner session verified. Open the new owner page in this Safari tab to keep the same development hostname.</p>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <a
          href="/api/admin/index2-key-provisioning/"
          className="text-[12px] font-bold text-[#34460b] underline underline-offset-2 hover:text-[#222a3d]"
        >
          Open NEW index-2 owner page
        </a>
        <a
          href="/api/admin/key-provisioning/"
          className="text-[12px] font-bold text-[#596271] underline underline-offset-2 hover:text-[#222a3d]"
        >
          Historical key provisioning
        </a>
      </div>
    </div>
  );
}