# BD Education Centre — Tokyo street hero: build-time GLB export
#
#   blender -b 3d-source/tokyo_street_night.blend -P tools/blender_export.py -- <out.glb>
#
# What this does, and why:
#   The stock Blender glTF export produced 1,742 separate primitives (one per object,
#   times material slots), each independently Draco-compressed. That gave a 1.15 MB JSON
#   chunk of pure scene-graph overhead and terrible compression ratios, and forced the
#   browser to re-merge everything in JavaScript on every single page load.
#
#   Here we do that merge ONCE, at build time:
#     - drop everything the runtime does not use (petals, lights, camera, animation)
#     - split multi-material objects, then join every object sharing a material
#     - one object per material  ->  one primitive per material  ->  ~45 draw calls
#     - strip UVs / colours / tangents (the scene has zero textures)
#
#   Material NAMES are the contract with the runtime theme system (src/scene/materials.js
#   keys off material.name), so they are preserved exactly and asserted at the end.

import bpy
import sys
import json
import bmesh

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = ARGS[0] if ARGS else '//export.glb'
REPORT = ARGS[1] if len(ARGS) > 1 else None

# The 42 kanji shop signs are FONT objects authored at resolution_u=12 with a bevel.
# Evaluated, they alone are 1,632,548 of the scene's 1,718,350 triangles — 95% of all
# geometry, for emissive text that is a few dozen pixels tall and gets smeared by bloom.
# Retessellating them is by far the largest single win available.
TEXT_RES = int(ARGS[2]) if len(ARGS) > 2 else 2
BEVEL_RES = int(ARGS[3]) if len(ARGS) > 3 else 0

log = []


def say(msg):
    print('[export] ' + msg)
    log.append(msg)


def deselect():
    bpy.ops.object.select_all(action='DESELECT')


def delete(objs):
    """Delete objects and return how many actually went away.

    Objects locked in the outliner have hide_select=True, which makes select_set() a
    silent no-op — bpy.ops.object.delete() then deletes nothing while the caller happily
    reports success. The scene's Atmo_Volume cube is exactly that, so clear every
    visibility and selectability flag first, and verify afterwards rather than assuming.
    """
    names = [o.name for o in objs if o.name in bpy.data.objects]
    if not names:
        return 0
    deselect()
    for n in names:
        o = bpy.data.objects[n]
        o.hide_select = False
        o.hide_viewport = False
        try:
            o.hide_set(False)
        except RuntimeError:
            pass  # not linked to the current view layer
        o.select_set(True)
    bpy.context.view_layer.objects.active = bpy.data.objects[names[0]]
    bpy.ops.object.delete()
    gone = sum(1 for n in names if n not in bpy.data.objects)
    if gone != len(names):
        say('WARN asked to delete %d objects, %d survived' % (len(names), len(names) - gone))
    return gone


# ---------------------------------------------------------------- 1. strip
if bpy.context.object and bpy.context.object.mode != 'OBJECT':
    bpy.ops.object.mode_set(mode='OBJECT')

before = len(bpy.data.objects)

# Petals are replaced by a GPU-instanced system in src/scene/petals.js — 110 objects,
# 110 AnimationClips and ~0.41 MB of baked keyframes for 220 triangles of geometry.
say('removed %d Petal_* objects' % delete([o for o in bpy.data.objects if o.name.startswith('Petal')]))

# 34 lights are never exported to glTF anyway (the look is emissive + bloom), and the
# camera is driven from assets/camera_path.json, not from the GLB.
say('removed %d lights/cameras/empties' % delete(
    [o for o in bpy.data.objects if o.type in {'LIGHT', 'CAMERA', 'EMPTY'}]))

# Respect the artist's render visibility — this is what the stock exporter did too.
say('removed %d render-hidden objects' % delete([o for o in bpy.data.objects if o.hide_render]))

# Cycles-only helpers that carry no meaning in a realtime renderer. Atmo_Volume is a
# 12-triangle cube with a volume shader standing in for atmospheric haze; three.js gets
# that from THREE.FogExp2 instead. It was absent from the original shipped GLB too.
# Dropped by material after the split below, not by object — a material can be one slot
# of a 46-slot building, and deleting the whole object would take the building with it.
EXCLUDE_MATERIALS = {'Atmo_Volume'}

# All animation goes; nothing in the runtime reads an AnimationClip any more.
for o in bpy.data.objects:
    o.animation_data_clear()
for act in list(bpy.data.actions):
    bpy.data.actions.remove(act)
say('cleared all actions')

# ------------------------------------------------- 2. curves/text -> mesh
# Retessellate before converting — see the TEXT_RES note at the top of this file.
retess = 0
for o in bpy.data.objects:
    if o.type not in {'FONT', 'CURVE'}:
        continue
    d = o.data
    d.resolution_u = TEXT_RES
    if hasattr(d, 'render_resolution_u'):
        d.render_resolution_u = TEXT_RES
    if hasattr(d, 'bevel_resolution'):
        d.bevel_resolution = BEVEL_RES
    retess += 1
say('retessellated %d curve/text objects to resolution_u=%d bevel_resolution=%d'
    % (retess, TEXT_RES, BEVEL_RES))

convert = [o for o in bpy.data.objects if o.type in {'FONT', 'CURVE', 'SURFACE', 'META'}]
if convert:
    deselect()
    for o in convert:
        o.select_set(True)
    bpy.context.view_layer.objects.active = convert[0]
    bpy.ops.object.convert(target='MESH')
    say('converted %d curve/text objects to mesh' % len(convert))

meshes = [o for o in bpy.data.objects if o.type == 'MESH']
say('%d mesh objects remain (from %d total objects)' % (len(meshes), before))

# --------------------------------------------- 3. apply modifiers + transforms
# Joining objects with differing transforms is fine (join bakes them), but modifiers
# must be resolved first or the join silently drops them.
deselect()
mod_applied = 0
for o in meshes:
    if not o.modifiers:
        continue
    bpy.context.view_layer.objects.active = o
    for m in list(o.modifiers):
        try:
            bpy.ops.object.modifier_apply(modifier=m.name)
            mod_applied += 1
        except RuntimeError as e:
            say('WARN could not apply %s on %s: %s' % (m.name, o.name, e))
say('applied %d modifiers' % mod_applied)

# ------------------------------------------ 4. split objects by material
# 46 objects carry 10 material slots each and 29 carry 2 — those are what turned
# 1,460 meshes into 1,742 primitives. Separate them so every object is single-material.
multi = [o for o in bpy.data.objects if o.type == 'MESH' and len(o.material_slots) > 1]
say('%d objects have >1 material slot -> separating' % len(multi))
for o in multi:
    deselect()
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    try:
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.mesh.separate(type='MATERIAL')
    finally:
        bpy.ops.object.mode_set(mode='OBJECT')

# Drop now-unused slots so each object reports exactly one material.
for o in [x for x in bpy.data.objects if x.type == 'MESH']:
    deselect()
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    try:
        bpy.ops.object.material_slot_remove_unused()
    except RuntimeError:
        pass

# ---------------------------------------------- 5. join by material
groups = {}
for o in [x for x in bpy.data.objects if x.type == 'MESH']:
    if not o.material_slots or not o.material_slots[0].material:
        continue
    if len(o.data.polygons) == 0:
        continue
    groups.setdefault(o.material_slots[0].material.name, []).append(o)

for mat_name in list(groups):
    if mat_name in EXCLUDE_MATERIALS:
        say('excluded material %s (%d objects)' % (mat_name, delete(groups.pop(mat_name))))

say('%d material groups to join' % len(groups))

joined = []
for mat_name in sorted(groups):
    objs = groups[mat_name]
    mat = objs[0].material_slots[0].material
    deselect()
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    target = bpy.context.view_layer.objects.active
    # join() unions the slot lists of everything it merged, so a joined object can end up
    # advertising materials none of its faces use — and the exporter emits those. Every
    # group is single-material by construction, so just restate that.
    target.data.materials.clear()
    target.data.materials.append(mat)
    for poly in target.data.polygons:
        poly.material_index = 0
    # The runtime looks meshes up by material name; give the object a stable name too.
    target.name = 'M_' + mat_name
    target.data.name = 'MD_' + mat_name
    joined.append((mat_name, target, len(objs)))

# Anything not folded into a join group is a zero-polygon leftover or an excluded
# material. Left in the scene it contributes nothing but still drags its material slot
# into the export, so the GLB ends up advertising materials no geometry uses.
keep = {o.name for _, o, _ in joined}
say('removed %d empty/leftover objects' % delete(
    [o for o in bpy.data.objects if o.type == 'MESH' and o.name not in keep]))

# --------------------------------------- 6. strip unused vertex attributes
# The scene has zero textures, so UVs are dead weight; likewise colour attributes and
# any sharp-edge/crease layers. POSITION + NORMAL is all the shaders read.
stripped = {'uv': 0, 'color': 0}
for _, o in [(m, o) for m, o, _ in joined]:
    me = o.data
    while me.uv_layers:
        me.uv_layers.remove(me.uv_layers[0])
        stripped['uv'] += 1
    while me.color_attributes:
        me.color_attributes.remove(me.color_attributes[0])
        stripped['color'] += 1
say('stripped %d uv layers, %d colour attributes' % (stripped['uv'], stripped['color']))

# Triangulate at build time so the exporter/loader never has to, and so the vertex
# cache optimiser downstream (meshopt) has a stable topology to work with.
for _, o, _ in joined:
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.to_mesh(o.data)
    bm.free()

# ------------------------------------------------------- 7. report + export
tris = 0
verts = 0
summary = []
for mat_name, o, n in sorted(joined, key=lambda r: r[0]):
    o.data.calc_loop_triangles()
    t = len(o.data.loop_triangles)
    v = len(o.data.vertices)
    tris += t
    verts += v
    summary.append({'material': mat_name, 'object': o.name, 'merged_from': n, 'tris': t, 'verts': v})

say('FINAL: %d objects, %d materials, %d tris, %d verts' % (len(joined), len(groups), tris, verts))

# Only pass exporter options this Blender build actually knows about — the glTF
# exporter's argument names drift between releases.
wanted = {
    'filepath': bpy.path.abspath(OUT),
    'export_format': 'GLB',
    'use_selection': False,
    'use_visible': True,
    'use_renderable': True,
    'export_apply': True,
    'export_yup': True,
    'export_texcoords': False,
    'export_normals': True,
    'export_tangents': False,
    'export_colors': False,
    'export_attributes': False,
    'export_materials': 'EXPORT',
    'export_cameras': False,
    'export_lights': False,
    'export_animations': False,
    'export_skins': False,
    'export_morph': False,
    'export_extras': False,
    'export_draco_mesh_compression_enable': False,
    'export_optimize_animation_size': False,
    'export_hierarchy_flatten_objs': True,
}
known = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
kwargs = {k: v for k, v in wanted.items() if k in known}
dropped = sorted(set(wanted) - known)
if dropped:
    say('exporter ignored unsupported options: %s' % ', '.join(dropped))

deselect()
bpy.ops.export_scene.gltf(**kwargs)
say('wrote %s' % kwargs['filepath'])

if REPORT:
    with open(bpy.path.abspath(REPORT), 'w', encoding='utf-8') as f:
        json.dump({'log': log, 'objects': summary, 'tris': tris, 'verts': verts,
                   'materials': sorted(groups)}, f, indent=1)
    say('wrote report %s' % REPORT)

print('===EXPORT_OK===')
