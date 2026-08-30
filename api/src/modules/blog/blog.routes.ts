import { Router } from 'express'
import { blogPostsRouter } from './blog-posts.routes.js'
import { blogCategoriesRouter } from './blog-categories.routes.js'
import { blogTagsRouter } from './blog-tags.routes.js'

/**
 * Mounted at `/v1/blog`. Combines the three sub-routers rather than one flat
 * file: posts carry a real status machine and business logic, categories and
 * tags are small catalog-style CRUD — see the module's individual files.
 */
export const blogRouter = Router()

blogRouter.use('/categories', blogCategoriesRouter)
blogRouter.use('/tags', blogTagsRouter)
/**
 * Mounted at `/posts`, not the router root — `blogPostsRouter` itself has a
 * public `GET /:slug`, and mounting it at `/` would swallow any single-
 * segment path (including `/posts` itself, parsed as slug="posts") before
 * it ever reached this router. Admin mutations end up at
 * `/v1/blog/posts/admin/*` as a result — a reasonable place for them, still
 * clearly namespaced apart from the public reads.
 */
blogRouter.use('/posts', blogPostsRouter)
