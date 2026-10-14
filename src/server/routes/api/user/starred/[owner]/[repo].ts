import { legacy } from '../../../../../api/legacy.js'
export const PUT = async (
  request: Request,
  { params }: { params: Promise<{ owner: string; repo: string }> },
) => legacy(request, 'star', await params)
export const DELETE = async (
  request: Request,
  { params }: { params: Promise<{ owner: string; repo: string }> },
) => legacy(request, 'unstar', await params)
