// Era for the extrinsics this package submits, on Bulletin and on Asset Hub.
// papi's own default is 20 blocks plus the best-to-finalized gap, shorter than
// the 64 the chunk retry and reconnect timing was built around.
export const SUBMIT_MORTALITY = { mortal: true as const, period: 64 };
