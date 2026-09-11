import type { AuthzService } from '@adonis-agora/authz';
import { hasPermissions } from '@adonis-agora/authz/mixins';
import { compose } from '@adonisjs/core/helpers';
import { BaseModel, belongsTo } from '@adonisjs/lucid/orm';
import type { BelongsTo } from '@adonisjs/lucid/types/relations';

const authz = undefined as unknown as AuthzService;

class User extends compose(
  BaseModel,
  hasPermissions(() => authz),
) {}

class Post extends BaseModel {
  @belongsTo(() => User)
  declare author: BelongsTo<typeof User>;
}

const user = new User();
void user.can('posts.view');
void new Post().author;
