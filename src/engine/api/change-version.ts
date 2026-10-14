export const CHANGE_VERSION='api-changes:v1'
export const changeCacheKey=(from:string|null,to:string)=>`${CHANGE_VERSION}:${from??'root'}:${to}`
