import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

const ADMIN_PREFIX = '/admin'
const LOGIN_PATH = '/admin/login'

function getAllowedEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname
  const hostname = request.headers.get('host') ?? ''

  if (pathname === '/' && hostname.includes('product-recommend')) {
    return NextResponse.redirect(new URL(ADMIN_PREFIX, request.url))
  }

  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          )
        },
      },
    },
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const allowed = getAllowedEmails()
  const isAllowedUser = user && allowed.includes((user.email ?? '').toLowerCase())

  if (pathname === LOGIN_PATH) {
    if (isAllowedUser) {
      return NextResponse.redirect(new URL(ADMIN_PREFIX, request.url))
    }
    return response
  }

  if (pathname.startsWith(ADMIN_PREFIX)) {
    if (!user) {
      return NextResponse.redirect(new URL(LOGIN_PATH, request.url))
    }
    if (!isAllowedUser) {
      await supabase.auth.signOut()
      const redirect = new URL(LOGIN_PATH, request.url)
      redirect.searchParams.set('error', 'unauthorized')
      return NextResponse.redirect(redirect)
    }
  }

  return response
}

export const config = {
  matcher: ['/', '/admin/:path*'],
}
