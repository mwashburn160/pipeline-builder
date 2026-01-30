import { Schema, model, Document, Types } from 'mongoose';
import slugify from 'slugify';

/**
 * Organization document interface
 */
export interface IOrganization extends Document {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  description?: string;
  owner: Types.ObjectId;
  members: Types.ObjectId[];
}

const organizationSchema = new Schema<IOrganization>(
  {
    name: {
      type: String,
      required: [true, 'Organization name is required'],
      trim: true,
      minlength: 2,
      maxlength: 100,
    },
    slug: {
      type: String,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
    },
    owner: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    members: [
      {
        type: Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
  },
  {
    timestamps: true,
    collection: 'organizations',
  },
);

/**
 * Generate unique slug from organization name
 */
organizationSchema.pre<IOrganization>('validate', async function () {
  if (!this.isModified('name') && this.slug) return;

  const baseSlug = slugify(this.name, { lower: true, strict: true });
  const slugRegex = new RegExp(`^(${baseSlug})(-[0-9]+)?$`, 'i');

  const existingOrgs = await (this.constructor as any)
    .find({
      slug: slugRegex,
      _id: { $ne: this._id },
    })
    .select('slug')
    .lean();

  if (existingOrgs.length === 0) {
    this.slug = baseSlug;
  } else {
    const suffixes = existingOrgs.map((org: any) => {
      const parts = org.slug.split('-');
      const lastPart = parseInt(parts[parts.length - 1]);
      return isNaN(lastPart) ? 0 : lastPart;
    });
    const maxSuffix = Math.max(0, ...suffixes);
    this.slug = `${baseSlug}-${maxSuffix + 1}`;
  }

  // Ensure owner is in members
  if (this.owner && !this.members.some(id => id.equals(this.owner))) {
    this.members.push(this.owner);
  }
});

export default model<IOrganization>('Organization', organizationSchema);
