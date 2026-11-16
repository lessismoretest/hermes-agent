import { cp, mkdir, readdir, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const exists = async (target: string): Promise<boolean> => {
  try {
    await access(target, constants.F_OK)

    return true
  } catch {
    return false
  }
}

/**
 * First-run cosmetic seeding.
 *
 * A build should look like the build it came from the moment it opens — nobody
 * should have to import a skin or drop in a plugin folder to get the same
 * statusbar, bubble colours and list geometry. The bundle carries that profile
 * under `Resources/default-profile/`; this copies it into the user's Hermes
 * home once, and never touches anything that already exists, so a user who
 * edits a skin (or deletes the cost widget) keeps their choice on the next
 * launch.
 */
export async function seedDefaultProfile(): Promise<void> {
  const source = path.join(process.resourcesPath, 'default-profile')

  if (!(await exists(source))) {
    return
  }

  const home = process.env.HERMES_HOME?.trim() || path.join(os.homedir(), '.hermes')

  const skins = path.join(source, 'skins')

  if (await exists(skins)) {
    const target = path.join(home, 'skins')
    await mkdir(target, { recursive: true })

    for (const name of await readdir(skins)) {
      const destination = path.join(target, name)

      if (!(await exists(destination))) {
        await cp(path.join(skins, name), destination)
      }
    }
  }

  const plugins = path.join(source, 'desktop-plugins')

  if (await exists(plugins)) {
    const target = path.join(home, 'desktop-plugins')
    await mkdir(target, { recursive: true })

    for (const id of await readdir(plugins)) {
      const destination = path.join(target, id)

      if (!(await exists(destination))) {
        await cp(path.join(plugins, id), destination, { recursive: true })
      }
    }
  }
}
