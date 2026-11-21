/** True for a Clerk user id (`user_...`). Ids are also used in file and sandbox names. */
export const isClerkUserId = (id: string) => /^user_[A-Za-z0-9]{10,64}$/.test(id)
