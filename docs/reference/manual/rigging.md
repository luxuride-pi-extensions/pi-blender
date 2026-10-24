# Rigging and Armatures Guide (Blender 4.2 LTS)

Skeletal rigs, bone hierarchies, skinning, and inverse kinematics (IK) in Blender 4.2.

## Armature Structure

An Armature object contains a skeletal structure made of bones:
- **Head**: Base joint of the bone.
- **Tail**: Tip joint of the bone.
- **Roll**: Axial rotation of the bone along its head-to-tail vector. Consistent bone roll is critical for predictable rotational axis orientation in Pose Mode.

### Interaction Modes
- **Edit Mode**: Defines rest pose morphology. Reposition bone head and tail coordinates, construct parent hierarchies (`use_connect=True` or `False`), adjust roll angles.
- **Pose Mode**: Defines interactive posing, keyframe animation, and constraint evaluation. Bone rest positions are not altered.

## Skinning Mesh to Armature

### Parenting with Automatic Weights
1. Ensure both mesh and armature share a common origin and scale is applied: `bpy.ops.object.transform_apply(scale=True, rotation=True)`.
2. Select the mesh object first, then Shift-select the armature object (armature must be active).
3. Run `bpy.ops.object.parent_set(type='ARMATURE_AUTO')`.
4. Blender creates:
   - An `ArmatureModifier` on the mesh object bound to the armature.
   - Deform vertex groups on the mesh corresponding exactly to each bone's name.
   - Smooth heat-map weight distribution across vertex vertices.

## Inverse Kinematics (IK)

Inverse Kinematics calculates intermediate bone rotations backwards from an end-effector target:
- Add an **IK Constraint** to the lower bone in a chain (e.g. Shin / Forearm):
  - `target`: Armature object.
  - `subtarget`: IK controller bone (e.g. Foot_IK, Hand_IK).
  - `chain_count`: Number of ancestor bones influenced (e.g. 2 for Thigh + Shin).
  - `pole_target`: Knee or Elbow hint target bone to prevent knee/elbow flipping.
  - `pole_angle`: Offset angle in radians aligning the knee bend direction to the pole bone.
